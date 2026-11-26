# Deploy CFS Admissions to an AWS lab

The [CloudFormation template](stack.yaml) creates the network across two Availability Zones, the Application Load Balancer, the Auto Scaling group and launch template, private PostgreSQL, and a CloudWatch log group. All application state lives in the shared database, so web instances are interchangeable. See [the architecture overview](ARCHITECTURE.md). It uses an existing EC2 instance profile. The default first deployment keeps the web group at zero and creates a one-off migration host. The live group runs with minimum 2, desired 2, maximum 4 and a 50% CPU target.

## Before creating the stack

- Confirm the permitted instance types, available budget, and two accessible Availability Zones in the lab. The template uses public web subnets with security group chaining. RDS is single-AZ.
- Confirm that the instance profile permits Session Manager, reading the application configuration from Secrets Manager, and writing to the deployment log group. The lab profile must also let the migration operator obtain the RDS master secret.
- Select a published Linux/amd64 image by digest. For a restricted GHCR package, create a separate Secrets Manager value with `username` and `token` keys and grant the instance profile read access. The token needs package read access.
- For a deployment that handles real credentials, provide the ACM certificate ARN, set the matching `PublicHostname`, and create the DNS record for the ALB. Use the HTTP-only path exclusively for a synthetic lab demonstration over a trusted connection.

## 1. Create infrastructure with the web fleet stopped

Run these commands from the repository root with an authenticated AWS CLI. Set parameters for your lab and use your image digest.

```bash
aws cloudformation validate-template --template-body file://infra/aws/stack.yaml
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name cfs-admissions-lab \
  --template-file infra/aws/stack.yaml \
  --parameter-overrides \
    ResourcePrefix=cfs-admissions ClassSerial=20 StudentAdminNumber=<your-admin-number> \
    AppImage=ghcr.io/jxng2021-oss/cfs_app@sha256:<image-digest> \
    AppSecretId=cfs-admissions/application \
    EnableWeb=false EnableMigrationHost=true

aws cloudformation describe-stacks --region us-east-1 --stack-name cfs-admissions-lab \
  --query 'Stacks[0].Outputs' --output table
```

Review the change set before applying if using a lab workflow that requires review. The application secret may be created or populated after the migration host and database exist. Include `CertificateArn` and `PublicHostname` in the parameter overrides for HTTPS. Include `RegistrySecretId` for a private image. You can pin an available database minor version using `PostgresEngineVersion` and the lab’s RDS engine version list.

## 2. Configure PostgreSQL and apply migrations

Connect to the migration instance with Session Manager. The host has Docker and the RDS CA bundle after cloud-init completes.

```bash
aws ssm start-session --region us-east-1 --target <MigrationInstanceId>
sudo cloud-init status --wait
sudo systemctl stop cfs-admissions
```

Connect to the database using the master user `admissions_admin`, the password in the `DatabaseMasterSecret` output, and the `DatabaseHost` output. Enter the password at the client prompt.

```bash
sudo docker run --rm -it --network host \
  --mount type=bind,src=/etc/cfs-admissions/rds-ca.pem,dst=/rds-ca.pem,readonly \
  postgres:16-alpine psql \
  'host=<DatabaseHost> port=5432 dbname=admissions user=admissions_admin sslmode=verify-full sslrootcert=/rds-ca.pem'
```

Create two login roles and set strong passwords through `\password`, which prompts interactively. The migration role owns the tables. The runtime role gets only the privileges the application needs. Run this SQL against the new database.

```sql
CREATE ROLE admissions_migrate LOGIN;
\password admissions_migrate
CREATE ROLE admissions_app LOGIN;
\password admissions_app
GRANT CONNECT ON DATABASE admissions TO admissions_migrate, admissions_app;
GRANT USAGE, CREATE ON SCHEMA public TO admissions_migrate;
GRANT USAGE ON SCHEMA public TO admissions_app;
```

Reconnect as `admissions_migrate` with the same TLS parameters and configure privileges for the tables it will create.

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE admissions_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO admissions_app;
ALTER DEFAULT PRIVILEGES FOR ROLE admissions_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO admissions_app;
```

Create the application secret identified by `AppSecretId` in Secrets Manager with the following JSON keys.

| Key | Value |
| --- | --- |
| `DATABASE_URL` | `postgres://admissions_app:<url-encoded-password>@<DatabaseHost>:5432/admissions?sslmode=verify-full&sslrootcert=/app/certs/rds-ca.pem` |
| `SESSION_PEPPER` | At least 32 random characters. Keep this stable across all instances and releases. |

On the migration host, run the migration with the same image reference passed to the stack and the migration user’s separate PostgreSQL URL. The mount contains the RDS trust bundle. Set the environment values in a private shell without saving secrets in shell history.

```bash
read -rs -p 'Migration PostgreSQL URL: ' DATABASE_URL && echo
read -rs -p 'Application session pepper: ' SESSION_PEPPER && echo
export DATABASE_URL SESSION_PEPPER
export APP_ORIGIN='<ApplicationOrigin>'
sudo --preserve-env=DATABASE_URL,SESSION_PEPPER,APP_ORIGIN docker run --rm --network host \
  --env DATABASE_URL --env SESSION_PEPPER --env APP_ORIGIN \
  --mount type=bind,src=/etc/cfs-admissions/rds-ca.pem,dst=/app/certs/rds-ca.pem,readonly \
  '<AppImage>' node dist/api/cli.js migrate
unset DATABASE_URL SESSION_PEPPER
```

Provision the first admin with the runtime role and the Secrets Manager configuration. Supply the administrator email and password for this command only.

```bash
read -r -p 'Bootstrap admin email: ' BOOTSTRAP_ADMIN_EMAIL
read -rs -p 'Bootstrap admin password: ' BOOTSTRAP_ADMIN_PASSWORD && echo
export BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD
sudo --preserve-env=BOOTSTRAP_ADMIN_EMAIL,BOOTSTRAP_ADMIN_PASSWORD docker run --rm --network host \
  --env-file /etc/cfs-admissions/runtime.env --env BOOTSTRAP_ADMIN_EMAIL --env BOOTSTRAP_ADMIN_PASSWORD \
  --mount type=bind,src=/etc/cfs-admissions/rds-ca.pem,dst=/app/certs/rds-ca.pem,readonly \
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

Capture target health in both zones and confirm that fresh requests are answered by different instances:

```bash
curl --fail '<ApplicationOrigin>/api/infrastructure/instance'
for i in $(seq 10); do curl -s -o /dev/null -D - '<ApplicationOrigin>/health' | grep -i x-served-by; done
```

Inside the application, **Infrastructure Status → Sample 10 requests** shows the same distribution. For resilience evidence, sign in, create a fictional applicant, terminate one instance, and confirm that you stay signed in, the applicant is still there, the site keeps serving from the remaining instance, and the Auto Scaling group launches a replacement that becomes healthy. Check Auto Scaling activity and the CloudWatch log group (one stream per instance ID). Use the RDS and security group screens to show private database access. Run a controlled CPU scaling demo only within the authorised lab budget.

The admin number passed as `StudentAdminNumber` is shown in the sidebar and on Infrastructure Status; administrators can also change it in **Settings → General**.

For a later release, run its migrations on a migration host before refreshing the Auto Scaling group with the new launch template version. Keep migrations additive while the previous image is still serving during the refresh. Migration `006-admissions.sql` is the exception: it replaces the former learning-management schema, so stop the old fleet before applying it to a database that held LMS data. A final RDS snapshot retained by the stack may continue to incur charges after stack deletion; review it when ending a lab exercise.
