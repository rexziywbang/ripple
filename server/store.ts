import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Job = {id:string;projectId:string;revision:number;kind:'plan'|'action';payload:string;status:string};

export function createStore(path:string) {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true});
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
      kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
    UPDATE jobs SET status='pending' WHERE status='running';`);
  const projectColumns=db.prepare('PRAGMA table_info(projects)').all() as Array<{name:string}>;
  if(!projectColumns.some(column=>column.name==='archived'))db.exec('ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  return {
    get<T>(id:string):T|undefined {const row=db.prepare('SELECT state FROM projects WHERE id=?').get(id) as {state:string}|undefined;return row?JSON.parse(row.state):undefined;},
    list(includeArchived=false){return db.prepare(`SELECT id,name FROM projects ${includeArchived?'':'WHERE archived=0'} ORDER BY rowid`).all() as Array<{id:string;name:string}>;},
    archive(id:string,archived:boolean){db.prepare('UPDATE projects SET archived=? WHERE id=?').run(archived?1:0,id);},
    save(id:string,name:string,state:unknown){db.prepare('INSERT INTO projects(id,name,state) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,state=excluded.state').run(id,name,JSON.stringify(state));},
    enqueue(job:Omit<Job,'status'>){db.prepare('INSERT OR IGNORE INTO jobs(id,project_id,revision,kind,payload,status,created_at) VALUES(?,?,?,?,?,\'pending\',?)').run(job.id,job.projectId,job.revision,job.kind,job.payload,new Date().toISOString());},
    next(kind?:'action'):Job|undefined {const row=db.prepare(`SELECT id,project_id AS projectId,revision,kind,payload,status FROM jobs WHERE status='pending' ${kind?"AND kind='action'":''} ORDER BY created_at,rowid LIMIT 1`).get() as Job|undefined;if(row)db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(row.id);return row;},
    finish(id:string,status='done'){db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status,id);},
    supersedePlans(id:string){db.prepare("UPDATE jobs SET status='superseded' WHERE project_id=? AND kind='plan' AND status IN ('pending','running')").run(id);},
    cancelActions(id:string,proposalIds:string[]){for(const proposalId of proposalIds)db.prepare("UPDATE jobs SET status='superseded' WHERE project_id=? AND id=? AND status='pending'").run(id,`action:${proposalId}`);},
    clearJobs(id:string){db.prepare('DELETE FROM jobs WHERE project_id=?').run(id);},
    transaction<T>(fn:()=>T):T {db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},
    close(){db.close();},
  };
}
