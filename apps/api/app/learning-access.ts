import type { Request, Response } from 'express';
import type pg from 'pg';
import { viewer, type Services } from './auth.js';
import { transaction } from './db.js';
import { ApiError, id } from './http.js';
import { editable, lockActor, scopedModule, type ModuleRow } from './modules.js';
import { reconcileExpired } from './quiz-engine.js';

export type LearningScope = {
  db: pg.PoolClient;
  module: ModuleRow;
  actorId: string;
  studentId: string | null;
  now: Date;
  asOf: Date;
};

export async function withLearning<T>(
  services: Services,
  req: Request,
  res: Response,
  write: boolean,
  work: (scope: LearningScope) => Promise<T>,
) {
  const { user } = viewer(res);
  const result = await transaction(services.pool, async (db) => {
    if (write) await lockActor(db, res, services);
    const module = await scopedModule(db, id(req, 'moduleId'), user.id, user.role, true);
    const now = await services.clock(db);
    const studentId = user.role === 'STUDENT' ? user.id : null;
    if (module.status !== 'ARCHIVED') await reconcileExpired(db, module.id, now, studentId);
    if (write) editable(module);
    if (write) await db.query('SAVEPOINT learner_action');
    try {
      return { value: await work({ db, module, actorId: user.id, studentId, now, asOf: module.archived_at ?? now }) };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (write) await db.query('ROLLBACK TO SAVEPOINT learner_action');
      return { error };
    }
  });
  if ('error' in result) throw result.error;
  return result.value;
}
