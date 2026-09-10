import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { ResolvedProfile } from './protocol';
import type { ActivitySummary } from './startPageProtocol';
export type { ActivitySummary } from './startPageProtocol';

export class ActivityConnectionError extends Error {}
export const ACTIVITY_TOKEN_KEY = 'hypeproofChat.workshopToken';
const PREFIX = 'hps.activity.credential.';
const ACTIVE = 'hps.activity.active';
export interface ActivityRecord extends ActivitySummary {
  version: 1; service: string; serverId: string;
  token: string; savedAt: number;
}
const digest = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export function activityService(url: string): string {
  const u = new URL(url);
  if (u.username || u.password || u.search || u.hash) throw new ActivityConnectionError('Service 주소를 확인해 주세요.');
  return u.href.replace(/\/+$/, '');
}
const canonical = (root: string) => fs.realpathSync(root);
const contexts = new WeakMap<vscode.ExtensionContext, ActivityConnections>();
export function activityConnections(context: vscode.ExtensionContext): ActivityConnections | undefined { return contexts.get(context); }

/** Local binding over VS Code's existing stores. This class grants no remote authority. */
export class ActivityConnections {
  private active?: ActivityRecord;
  private readonly dir: string;
  constructor(private raw: vscode.ExtensionContext, private service: () => string, private root: () => string | undefined,
    private validate: (token: string) => Promise<ResolvedProfile>) {
    this.dir = path.join(raw.globalStorageUri.fsPath, 'activity-bindings');
  }
  get current(): ActivityRecord | undefined { return this.active; }
  get scope(): string | undefined { return this.active?.id; }
  get matchesService(): boolean { try { return !!this.active && this.active.service === activityService(this.service()); } catch { return false; } }
  async initialize(): Promise<void> {
    const ref = this.raw.workspaceState.get<string | null>(ACTIVE);
    if (ref === null) return;
    let record = ref?.startsWith(PREFIX) ? await this.read(ref) : undefined;
    const root = this.root();
    if (root && fs.existsSync(root) && record?.workspace !== canonical(root)) {
      const file = this.bindingPath(root);
      const bound = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')).ref : undefined;
      record = typeof bound === 'string' ? await this.read(bound) : undefined;
    }
    if (record) this.active = record; // pinned to this window, never follows another window's writes
  }
  private async read(ref: string): Promise<ActivityRecord | undefined> {
    if (!ref.startsWith(PREFIX)) return;
    const value = await this.raw.secrets.get(ref);
    if (!value) return;
    let r: ActivityRecord;
    try { r=JSON.parse(value); } catch { throw new ActivityConnectionError('저장된 활동 연결을 읽지 못했습니다. 코드를 다시 입력해 주세요.'); }
    if (r.version !== 1 || r.ref !== ref || typeof r.token !== 'string' || typeof r.name !== 'string' || !Number.isFinite(r.savedAt) || !/^[a-f0-9]{64}$/.test(r.serverId) ||
      r.id !== digest(JSON.stringify([r.service, r.serverId])) || !path.isAbsolute(r.workspace)) throw new ActivityConnectionError('저장된 활동 연결을 읽지 못했습니다. 코드를 다시 입력해 주세요.');
    return r;
  }
  async hasLegacyConnection():Promise<boolean> { return (await this.raw.secrets.keys()).includes(ACTIVITY_TOKEN_KEY); }
  async list(): Promise<ActivitySummary[]> {
    const found = new Map<string, ActivityRecord>();
    for (const ref of await this.raw.secrets.keys()) {
      if (!ref.startsWith(PREFIX)) continue;
      const r = await this.read(ref);
      if (r?.service !== activityService(this.service())) continue;
      if (!found.has(r.id) || found.get(r.id)!.savedAt < r.savedAt) found.set(r.id, r);
    }
    return [...found.values()].map(({ref,id,name,kind,workspace}) => ({ref,id,name,kind,workspace}));
  }
  async candidate(ref: string): Promise<ActivityRecord> {
    const r = await this.read(ref);
    if (!r || r.service !== activityService(this.service())) throw new ActivityConnectionError('현재 서버의 저장된 활동이 아닙니다.');
    return r;
  }
  async token(): Promise<string | undefined> { return this.matchesService ? this.active?.token : undefined; }
  private bindingPath(root: string): string { return path.join(this.dir, digest(canonical(root)) + '.json'); }
  private claim(root: string, id: string): void {
    fs.mkdirSync(this.dir, {recursive:true,mode:0o700});
    const file = this.bindingPath(root);
    try { fs.writeFileSync(file, JSON.stringify({version:1,id}), {flag:'wx',mode:0o600}); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (JSON.parse(fs.readFileSync(file,'utf8')).id !== id) throw new ActivityConnectionError('이 폴더는 다른 활동에 연결돼 있습니다. 다른 작업 폴더를 선택해 주세요.');
  }
  prepare(root:string,p:ResolvedProfile,prepare:()=>void):void {
    if (!/^[a-f0-9]{64}$/.test(p.activity_id ?? '')) throw new ActivityConnectionError('활동 정보를 다시 확인해 주세요.');
    fs.mkdirSync(root,{recursive:true});
    fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
    const release=this.lock(root);
    try {
      this.claim(root,digest(JSON.stringify([activityService(this.service()),p.activity_id])));
      prepare();
    } finally { release(); }
  }
  async commit(token: string, p: ResolvedProfile, root: string): Promise<() => Promise<void>> {
    if (!/^[a-f0-9]{64}$/.test(p.activity_id ?? '')) throw new ActivityConnectionError('서버가 활동 분리를 지원하지 않습니다. 연결 서버를 업데이트해 주세요.');
    const service = activityService(this.service()), workspace = canonical(root);
    const id = digest(JSON.stringify([service,p.activity_id]));
    fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
    const release=this.lock(workspace);
    const previous = this.active;
    const previousPointer = this.raw.workspaceState.get<string | null>(ACTIVE);
    const bindingFile = this.bindingPath(workspace);
    const oldBinding = fs.existsSync(bindingFile) ? fs.readFileSync(bindingFile,'utf8') : undefined;
    const sameWindowRoot = !!this.root() && canonical(this.root()!) === workspace;
    const ref = PREFIX + crypto.randomUUID();
    const next: ActivityRecord = {version:1,ref,id,service,serverId:p.activity_id!,workspace,token,
      name:p.lesson?.content.title ?? p.display_name,kind:p.activity_kind,savedAt:Date.now()};
    const restore = () => {
      if (!fs.existsSync(bindingFile)) return;
      const bound=JSON.parse(fs.readFileSync(bindingFile,'utf8'));
      if (bound.ref !== ref && !(oldBinding===undefined && bound.id===id && !bound.ref)) return;
      if (oldBinding===undefined) fs.unlinkSync(bindingFile);
      else fs.writeFileSync(bindingFile,oldBinding,{mode:0o600});
    };
    const tmp = bindingFile + '.' + crypto.randomUUID();
    try {
      this.claim(workspace,id);
      await this.raw.secrets.store(ref,JSON.stringify(next));
      fs.writeFileSync(tmp,JSON.stringify({version:1,id,ref}),{flag:'wx',mode:0o600});
      fs.renameSync(tmp,bindingFile);
      if (sameWindowRoot) await this.raw.workspaceState.update(ACTIVE,ref);
      this.active = next;
    } catch (e) {
      restore();
      await this.raw.secrets.delete(ref);
      throw e;
    } finally {
      if(fs.existsSync(tmp)) fs.unlinkSync(tmp);
      release();
    }
    return async () => {
      const unlock=this.lock(workspace);
      try {
        if (sameWindowRoot && this.raw.workspaceState.get(ACTIVE)===ref) await this.raw.workspaceState.update(ACTIVE,previousPointer);
        restore();
        this.active = previous;
        await this.raw.secrets.delete(ref);
      } finally { unlock(); }
    };
  }
  async disconnect(): Promise<void> { await this.raw.workspaceState.update(ACTIVE,null); this.active=undefined; }
  /** One active writer per physical folder across extension-host processes. */
  acquire(): () => void {
    const r = this.active, root = this.root();
    if (!r || !this.matchesService) throw new ActivityConnectionError('활동에 다시 연결한 뒤 보내 주세요.');
    if (!root || canonical(root) !== r.workspace) throw new ActivityConnectionError('이 활동의 작업 폴더를 열고 다시 보내 주세요.');
    this.claim(root,r.id);
    return this.lock(root);
  }
  private lock(root:string):()=>void {
    const lock = this.bindingPath(root) + '.lock';
    const recovery=lock+'.recovery';
    const busy=()=>new ActivityConnectionError('다른 창에서 이 폴더를 사용 중입니다. 작업이 끝난 뒤 다시 보내 주세요.');
    const nonce = crypto.randomUUID();
    for (let attempt=0;attempt<2;attempt++) {
      if (fs.existsSync(recovery)) throw busy();
      try { fs.writeFileSync(lock,JSON.stringify({pid:process.pid,nonce}),{flag:'wx',mode:0o600});
        if (fs.existsSync(recovery)) { fs.unlinkSync(lock); throw busy(); }
        return () => { if (fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock,'utf8')).nonce === nonce) fs.unlinkSync(lock); };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const owner = JSON.parse(fs.readFileSync(lock,'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new ActivityConnectionError('작업 폴더 잠금 정보를 확인할 수 없습니다.');
        try { process.kill(owner.pid,0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            // Serialize dead-owner recovery. Acquirers check this barrier both
            // before and after creating a lock, so recovery cannot unlink a new owner.
            try { fs.mkdirSync(recovery,{mode:0o700}); } catch { throw busy(); }
            try {
              if (fs.existsSync(lock)) {
                const latest=JSON.parse(fs.readFileSync(lock,'utf8'));
                if (latest.nonce===owner.nonce) fs.unlinkSync(lock);
              }
            } finally { fs.rmdirSync(recovery); }
            continue;
          }
        }
        throw new ActivityConnectionError('다른 창에서 이 폴더를 사용 중입니다. 작업이 끝난 뒤 다시 보내 주세요.');
      }
    }
    throw new ActivityConnectionError('작업 폴더 잠금을 얻지 못했습니다. 다시 시도해 주세요.');
  }
  wrap(): vscode.ExtensionContext {
    const original = this.raw.secrets;
    const scoped = Object.create(this.raw) as vscode.ExtensionContext;
    const secrets: vscode.SecretStorage = {
      get:key => key===ACTIVITY_TOKEN_KEY ? this.token() : original.get(key),
      store:async (key,value) => {
        if (key!==ACTIVITY_TOKEN_KEY) return original.store(key,value);
        const root=this.root(); if (!root) throw new ActivityConnectionError('작업 폴더를 먼저 선택해 주세요.');
        await this.commit(value,await this.validate(value),root);
      },
      delete:key => key===ACTIVITY_TOKEN_KEY ? this.disconnect() : original.delete(key),
      keys:()=>original.keys(), onDidChange:original.onDidChange,
    };
    Object.defineProperty(scoped,'secrets',{value:secrets});
    contexts.set(scoped,this);
    return scoped;
  }
}
