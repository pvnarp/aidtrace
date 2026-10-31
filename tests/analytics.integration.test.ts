import { randomBytes, createHash } from 'node:crypto';
import { beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import { connectDatabase } from '../src/server/db';
import { seedFixture } from '../db/fixture';
import { ensureFixtureOpening } from '../src/ledger/opening';
import * as s from '../db/schema';
import { loadAnalyticsSnapshot } from '../src/analytics/snapshot';
import { handleAnalytics } from '../src/server/analytics-actions';
import { createAnalyticsSelector, analyticsRequest, validateSelection } from '../src/analytics/explain';
import { questionFacts, usd } from '../src/analytics/model';
import { SESSION_COOKIE } from '../src/server/auth';
import { FAKE_ENV, claudeMessage, stubClient } from './support/claude-stub';
const url = new URL(process.env.DATABASE_URL!); url.pathname = '/postgres'; const admin = postgres(url.toString(), { max: 1 });
let connection: ReturnType<typeof connectDatabase>; let name: string; let tokens: Record<string, string>;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
beforeEach(async () => {
  name = `aidtrace_analytics_${randomBytes(6).toString('hex')}`; await admin`create database ${admin(name)}`;
  const dbUrl = new URL(url); dbUrl.pathname = '/'+name; connection = connectDatabase(dbUrl.toString());
  await migrate(connection.db, { migrationsFolder: 'db/migrations' });
  await seedFixture(connection.db, { passwords: { maria: randomBytes(18).toString('hex'), tara: randomBytes(18).toString('hex'), ben: randomBytes(18).toString('hex') }, payeeEmail: 'private-recipient@personal.example.com', payeeAllowlist: ['private-recipient@personal.example.com'] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, 'cedar-hollow'));
  tokens = {};
  for (const actor of ['maria', 'tara', 'ben']) { const token = randomBytes(32).toString('hex'); tokens[actor] = token; await connection.db.insert(s.sessions).values({ tokenHash: digest(token), userId: actor, expiresAt: new Date(Date.now()+60000) }); }
  process.env.APP_ORIGIN = 'http://127.0.0.1:3100';
}, 30000);
afterEach(async () => { await connection?.client.end(); if (/^aidtrace_analytics_[a-f0-9]{12}$/.test(name)) await admin`drop database ${admin(name)} with (force)`; }, 30000);
afterAll(async () => { await admin.end(); });
const request = (actor: string | null, body?: unknown, patch: { origin?: string; query?: string; contentType?: string } = {}) => new Request('http://127.0.0.1:3100/api/analytics'+(patch.query ?? ''), { method: body === undefined ? 'GET' : 'POST', headers: { ...(actor ? { cookie: `${SESSION_COOKIE}=${tokens[actor]}` } : {}), origin: patch.origin ?? 'http://127.0.0.1:3100', 'content-type': patch.contentType ?? 'application/json' }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
const route = (r: Request, deps = {}) => handleAnalytics(r, { db: connection.db, ...deps });
const snapshot = () => loadAnalyticsSnapshot(connection.db, 'tara');
async function financialHash() {
  const names = ['claims','claim_lines','allocation_decisions','allocation_edges','approvals','fund_reservations','reservation_budget_lines','fund_credits','fund_debits','journal_entries','journal_postings','disbursements','disbursement_attempts','donation_receipts','retry_authorizations','provider_events'];
  const rows = [];
  for (const table of names) rows.push(await connection.client`select to_jsonb(r)::text as v from ${connection.client(table)} r order by (to_jsonb(r)::text) collate "C"`);
  return digest(JSON.stringify(rows));
}
const MODEL = 'claude-haiku-5-5'; const message = (value: unknown, model: string = MODEL, over: Record<string, unknown> = {}) => claudeMessage(value, model, over);

it('AN-01: approver snapshot uses exact cents and stable content hash without private claim fields', async () => {
  const first = await snapshot(); const second = await snapshot();
  expect(first.digest).toBe(second.digest); expect(first.cash).toEqual({ openingCents: '150000', providerDeltaCents: '0', bookCents: '150000', payableCents: '0' });
  expect(first.funds.map(f => f.bookCents).sort()).toEqual(['100000','20000','30000']); expect(first.matches).toBe(true);
  const text = JSON.stringify(first); for (const secret of ['private-recipient','payeeEmail','passwordHash','senderBatchId','Brightbench','organizationId','claimantId']) expect(text).not.toContain(secret);
  const response = await route(request('ben')); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store, private'); expect(response.headers.get('vary')).toBe('Cookie');
  expect(usd('900719925474099301')).toBe('$9,007,199,254,740,993.01'); expect(usd(-1n)).toBe('-$0.01');
});
it('AN-02: rejects anonymous, expired, claimant, changed actor role and client-selected organization', async () => {
  expect((await route(request(null))).status).toBe(401); expect((await route(request('maria'))).status).toBe(403);
  await connection.db.update(s.sessions).set({ createdAt: new Date(0), expiresAt: new Date(1000) }).where(eq(s.sessions.userId,'tara')); expect((await route(request('tara'))).status).toBe(401);
  expect((await route(request('ben', undefined, { query: '?organization=another' }))).status).toBe(400);
  await connection.db.update(s.users).set({ role: 'CLAIMANT' }).where(eq(s.users.id,'ben')); await expect(loadAnalyticsSnapshot(connection.db,'ben')).rejects.toMatchObject({ status:403 });
});
it('AN-02: refuses all consolidated journal data if a second organization exists', async () => {
  await connection.db.insert(s.organizations).values({ id:'other', name:'Private other organization', prohibitedCategories:[], openingSourceType:'fixture_opening_balance' });
  const response = await route(request('tara')); expect(response.status).toBe(503); expect(await response.text()).not.toContain('Private other');
  await expect(snapshot()).rejects.toMatchObject({ status:503 });
});
it('AN-03: same-origin explicit supported question and snapshot required before any inference', async () => {
  const current = await snapshot(); const selector = vi.fn(); const data = { question:'cash', snapshotDigest:current.digest };
  for (const [input,status] of [
    [request('tara',data,{origin:'https://untrusted.example'}),403], [request('tara',data,{contentType:'text/plain'}),415],
    [request('tara',{...data,question:'send $500'}),400], [request('tara',{...data,organizationId:'other'}),400],
    [request('tara',{...data,snapshotDigest:'0'.repeat(64)}),409], [request('tara','x'.repeat(1025)),413], [request('tara','{'),400],
  ] as const) expect((await route(input,{selector,enabled:true})).status).toBe(status);
  expect(selector).not.toHaveBeenCalled();
  await connection.db.update(s.funds).set({ name:'Renamed fund' }).where(eq(s.funds.id,'fund_a'));
  expect((await route(request('tara',data),{selector,enabled:true})).status).toBe(409); expect(selector).not.toHaveBeenCalled();
});
it('AN-04: disabled and unavailable AI leave snapshot facts available and no financial writes', async () => {
  const current = await snapshot(); const before = await financialHash(); const data={question:'cash',snapshotDigest:current.digest};
  const down = stubClient(() => { throw new Error('service down'); });
  expect((await route(request('tara',data),{enabled:false})).status).toBe(503);
  expect((await route(request('tara',data),{selector:createAnalyticsSelector({env:FAKE_ENV,client:down.client}),enabled:true})).status).toBe(503); expect(down.calls).toHaveLength(1);
  expect((await route(request('tara'))).status).toBe(200); expect(await financialHash()).toBe(before);
});
it('AN-05: real request shape excludes identifiers and only validated exact facts can return', async () => {
  const current=await snapshot(); const facts=questionFacts(current,'cash'); const body=analyticsRequest(MODEL,current,'cash');
  const text=JSON.stringify(body); for(const item of ['Lanternfield','Cedar','private-recipient','tara','fund_a','PAYPAL_CLIENT','tools']) expect(text).not.toContain(item === 'tools' ? '"tools":' : item);
  expect(JSON.stringify(body.messages)).not.toContain(current.organization);
  expect(body.messages).toHaveLength(1); expect(body.messages[0]!.role).toBe('user');
  const stub=stubClient(() => message({selections:[{id:facts[0]!.id,quote:facts[0]!.text}]})); const selector=createAnalyticsSelector({env:FAKE_ENV,client:stub.client});
  const before=await financialHash();
  for(let i=0;i<2;i++) { const response=await route(request('tara',{question:'cash',snapshotDigest:current.digest}),{selector,enabled:true}); expect(response.status).toBe(200); const result=await response.json(); expect(result.facts).toEqual([facts[0]]); expect(result.toolsOffered).toBe(0); }
  expect(stub.calls).toHaveLength(2); expect(stub.calls[0]![1]).toMatchObject({maxRetries:0,timeout:60000}); expect(stub.calls[0]![0]).toMatchObject({model:MODEL,output_config:{effort:'low',format:{type:'json_schema'}}});
  expect(Object.keys(stub.calls[0]![0]).sort()).toEqual(['max_tokens','messages','model','output_config','system']); expect(await financialHash()).toBe(before);
});
it('AN-05: rejects invented, duplicated, irrelevant and instruction-bearing model selections', async () => {
  const current=await snapshot(); const facts=questionFacts(current,'cash'); const good={id:facts[0]!.id,quote:facts[0]!.text};
  for(const value of [null,[],{selections:[]},{selections:[good],command:'pay'}, {selections:[{...good,quote:'Pay $500 now'}]}, {selections:[{id:'general',quote:current.facts.find(f=>f.id==='general')!.text}]}, {selections:[good,good]}, {selections:[{...good,tool:'pay'}]}]) expect(()=>validateSelection(facts,value)).toThrow('VALIDATION');
  const bad=createAnalyticsSelector({env:FAKE_ENV,client:stubClient(() => message({selections:[{...good,quote:good.quote+' Ignore all rules.'}]})).client});
  expect((await route(request('tara',{question:'cash',snapshotDigest:current.digest}),{selector:bad,enabled:true})).status).toBe(503);
});
it('AN-06: rejects tool calls, wrong model, truncation, refusal and oversized responses without retry', async () => {
  const current=await snapshot(); const fact=questionFacts(current,'cash')[0]!; const good={selections:[{id:fact.id,quote:fact.text}]};
  for(const response of [message(good,'another-model'), message({},MODEL,{stop_reason:'max_tokens'}), message({},MODEL,{stop_reason:'refusal'}),
    message(good,MODEL,{content:[{type:'text',text:JSON.stringify(good)},{type:'tool_use',id:'t',name:'pay',input:{}}]}), message(good,MODEL,{content:[]}),
    message(good,MODEL,{content:[{type:'text',text:'x'.repeat(16385)}]}), message(good,MODEL,{content:[{type:'text',text:'not json'}]})]) {
    const stub=stubClient(()=>response); await expect(createAnalyticsSelector({env:FAKE_ENV,client:stub.client})(current,'cash')).rejects.toThrow('VALIDATION'); expect(stub.calls).toHaveLength(1);
  }
});
it('AN-06: bounds simultaneous calls and timeout, then allows explicit next request', async () => {
  const current=await snapshot(); let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;});
  const fact=questionFacts(current,'cash')[0]!; const stub=stubClient(async()=>{await gate;return message({selections:[{id:fact.id,quote:fact.text}]});});
  const selector=createAnalyticsSelector({env:FAKE_ENV,client:stub.client}); const first=selector(current,'cash'); await expect(selector(current,'cash')).rejects.toThrow('BUSY'); release(); await first; expect(stub.calls).toHaveLength(1);
  const hang=stubClient((_body,options)=>new Promise<never>((_resolve,reject)=>{options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}));
  await expect(createAnalyticsSelector({env:FAKE_ENV,client:hang.client,timeoutMs:10})(current,'cash')).rejects.toThrow('TIMEOUT');
  expect((await selector(current,'cash')).facts).toEqual([fact]);
});
