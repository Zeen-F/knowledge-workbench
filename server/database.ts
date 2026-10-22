import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "workbench.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, id TEXT NOT NULL, title TEXT NOT NULL, note_type TEXT, domain TEXT, status TEXT, hash TEXT NOT NULL, updated_at TEXT NOT NULL, tags TEXT NOT NULL, owner TEXT NOT NULL, missing INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS notes_id ON notes(id);
    CREATE TABLE IF NOT EXISTS assets(hash TEXT PRIMARY KEY,path TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,path TEXT NOT NULL,ref TEXT NOT NULL,text TEXT NOT NULL,transfer_id TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS capture_trash(source_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS relations(from_path TEXT NOT NULL,to_ref TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(from_path,to_ref,kind));
    CREATE TABLE IF NOT EXISTS extractions(path TEXT PRIMARY KEY,source_id TEXT NOT NULL,source_hash TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL,executor TEXT NOT NULL,created_at TEXT NOT NULL,error TEXT,snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_items(job_id TEXT NOT NULL REFERENCES jobs(id),source_id TEXT NOT NULL,state TEXT NOT NULL,output TEXT,error TEXT,PRIMARY KEY(job_id,source_id));
    CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,status TEXT NOT NULL,path TEXT NOT NULL,body TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,accepted_path TEXT);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED,title,body,tags,tokenize='trigram');
    PRAGMA user_version=1;`);
  db.prepare(
    "UPDATE jobs SET state='paused',error='上次处理被中断，已完成分项保留。' WHERE state='running'",
  ).run();
  db.prepare(
    "UPDATE job_items SET state='pending' WHERE state='running'",
  ).run();
  return db;
}
