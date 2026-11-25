# Deploy CFS Learn to an AWS lab

The [CloudFormation template](stack.yaml) creates the network, two Availability Zones, ALB, Auto Scaling group, private PostgreSQL, S3 bucket, and CloudWatch log group. It uses an existing EC2 instance profile. The default first deployment keeps the web group at zero and creates a one-off migration host. The live group runs with minimum 2, desired 2, maximum 4 and a 50% CPU target.

## Before creating the stack

- Confirm the permitted instance types, available budget, and two accessible Availability Zones in the lab. The template uses public web subnets with security group chaining and an S3 gateway endpoint. RDS is single-AZ.
- Confirm that the instance profile permits Session Manager, pulling application configuration from Secrets Manager, read/write/delete on the upload bucket, and writing to the deployment log group. The lab profile must also let the migration operator obtain the RDS master secret.
- Select a published Linux/amd64 image by digest. For a restricted GHCR package, create a separate Secrets Manager value with `username` and `token` keys and grant the instance profile read access. The token needs package read access.
- For a deployment that handles real credentials, provide the ACM certificate ARN, set the matching `PublicHostname`, and create the DNS record for the ALB. Use the HTTP-only path exclusively for a synthetic lab demonstration over a trusted connection.

## 1. Create infrastructure with the web fleet stopped

Run these commands from the repository root with an authenticated AWS CLI. Set parameters for your lab and use your image digest.

```bash
aws cloudformation validate-template --template-body file://infra/aws/stack.yaml
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name cfs-learn-lab \
  --template-file infra/aws/stack.yaml \
  --parameter-overrides \
    ResourcePrefix=cfs-learn-lab ClassSerial=20 \
    AppImage=ghcr.io/jxng2021-oss/cfs_app@sha256:<image-digest> \
    AppSecretId=cfs-learn-lab/application \
    EnableWeb=false EnableMigrationHost=true

aws cloudformation describe-stacks --region us-east-1 --stack-name cfs-learn-lab \
  --query 'Stacks[0].Outputs' --output table
```

Review the change set before applying if using a lab workflow that requires review. The application secret may be created or populated after the migration host and database exist. Include `CertificateArn` and `PublicHostname` in the parameter overrides for HTTPS. Include `RegistrySecretId` for a private image. You can pin an available database minor version using `PostgresEngineVersion` and the lab’s RDS engine version list.

## 2. Configure PostgreSQL and apply migrations

Connect to the migration instance with Session Manager. The host has Docker and the RDS CA bundle after cloud-init completes.

```bash
aws ssm start-session --region us-east-1 --target <MigrationInstanceId>
sudo cloud-init status --wait
sudo systemctl stop cfs-learn
```

Connect to the database using the master user `lms_admin`, the password in the `DatabaseMasterSecret` output, and the `DatabaseHost` output. Enter the password at the client prompt.

```bash
sudo docker run --rm -it --network host \
  --mount type=bind,src=/etc/cfs-learn/rds-ca.pem,dst=/rds-ca.pem,readonly \
  postgres:16-alpine psql \
  'host=<DatabaseHost> port=5432 dbname=minilms user=lms_admin sslmode=verify-full sslrootcert=/rds-ca.pem'
```

Create two login roles and set strong passwords through `\password`, which prompts interactively. The migration role owns the tables. The runtime role gets only the privileges the application needs. Run this SQL against the new database.

```sql
CREATE ROLE lms_migrate LOGIN;
\password lms_migrate
CREATE ROLE lms_app LOGIN;
\password lms_app
GRANT CONNECT ON DATABASE minilms TO lms_migrate, lms_app;
GRANT USAGE, CREATE ON SCHEMA public TO lms_migrate;
GRANT USAGE ON SCHEMA public TO lms_app;
```

Reconnect as `lms_migrate` with the same TLS parameters and configure privileges for the tables it will create.

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE lms_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lms_app;
```

Create the application secret identified by `AppSecretId` in Secrets Manager with the following JSON keys.

| Key | Value |
| --- | --- |
| `DATABASE_URL` | `postgres://lms_app:<url-encoded-password>@<DatabaseHost>:5432/minilms?sslmode=verify-full&sslrootcert=/app/certs/rds-ca.pem` |
| `SESSION_PEPPER` | At least 32 random characters. Keep this stable across all instances and releases. |

On the migration host, run the migration with the same image reference passed to the stack and the migration user’s separate PostgreSQL URL. The mount contains the RDS trust bundle. Set the environment values in a private shell without saving secrets in shell history.

```bash
read -rs -p 'Migration PostgreSQL URL: ' DATABASE_URL && echo
read -rs -p 'Application session pepper: ' SESSION_PEPPER && echo
export DATABASE_URL SESSION_PEPPER
export APP_ORIGIN='<ApplicationOrigin>'
sudo --preserve-env=DATABASE_URL,SESSION_PEPPER,APP_ORIGIN docker run --rm --network host \
  --env DATABASE_URL --env SESSION_PEPPER --env APP_ORIGIN \
  --mount type=bind,src=/etc/cfs-learn/rds-ca.pem,dst=/app/certs/rds-ca.pem,readonly \
  '<AppImage>' node dist/api/cli.js migrate
unset DATABASE_URL SESSION_PEPPER
```

Provision the first admin with the runtime role and the Secrets Manager configuration. Supply the administrator email and password for this command only.

```bash
read -r -p 'Bootstrap admin email: ' BOOTSTRAP_ADMIN_EMAIL
read -rs -p 'Bootstrap admin password: ' BOOTSTRAP_ADMIN_PASSWORD && echo
export BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD
sudo --preserve-env=BOOTSTRAP_ADMIN_EMAIL,BOOTSTRAP_ADMIN_PASSWORD docker run --rm --network host \
  --env-file /etc/cfs-learn/runtime.env --env BOOTSTRAP_ADMIN_EMAIL --env BOOTSTRAP_ADMIN_PASSWORD \
  --mount type=bind,src=/etc/cfs-learn/rds-ca.pem,dst=/app/certs/rds-ca.pem,readonly \
  '<AppImage>' node dist/api/cli.js bootstrap-admin
unset BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD
```

## 3. Enable the web fleet and verify

Update the same CloudFormation stack and set `EnableWeb=true` and `EnableMigrationHost=false`. Preserve the same image, resource, certificate and secret parameters. Verify that both targets become healthy and that the ALB origin serves the application.

```bash
aws elbv2 describe-target-health --region us-east-1 --target-group-arn '<TargetGroupArn>'
curl --fail --include '<ApplicationOrigin>/health'
curl --fail '<ApplicationOrigin>/health/ready'
```

Capture target health in both zones and confirm that multiple fresh requests report different `X-Served-By` instance IDs. For resilience evidence, sign in, upload a synthetic assignment file, replace an instance in the lab, confirm the same session and file still work, then check Auto Scaling activity and the CloudWatch log group. Use the RDS and security group screens to verify private database access. Run a controlled CPU scaling demo only within the authorised lab budget.

For a later release, run its additive migrations on a migration host before refreshing the Auto Scaling group with the new launch template version. Avoid removing columns or behavior still required by the previous image during the refresh. Run `node dist/api/cli.js cleanup-uploads` as a one-off maintenance task from an instance with the runtime configuration. An intentionally retained S3 bucket and final RDS snapshot may continue to incur charges after stack deletion. Review those retained resources separately when ending a lab exercise.
