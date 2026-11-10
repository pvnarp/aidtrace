import { randomBytes, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connectDatabase } from '../src/server/db';
import { seedFixture } from '../db/fixture';
import { ensureFixtureOpening } from '../src/ledger/opening';
import { loadAnalyticsSnapshot } from '../src/analytics/snapshot';
import { questionFacts } from '../src/analytics/model';
let admin: ReturnType<typeof postgres>; let connection: ReturnType<typeof connectDatabase>; let name:string;
let server: ChildProcess; let model:Server; let unavailable=false; let modelCalls=0; let passwords:Record<string,string>;
let originalHash:string;
async function financialHash() {
  const tables=['claims','claim_lines','allocation_decisions','allocation_edges','approvals','fund_reservations','reservation_budget_lines','fund_credits','fund_debits','journal_entries','journal_postings','disbursements','disbursement_attempts','donation_receipts','retry_authorizations','provider_events'];
  const rows=[];for(const table of tables)rows.push(await connection.client`select to_jsonb(r)::text as v from ${connection.client(table)} r order by (to_jsonb(r)::text) collate "C"`);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
test.beforeAll(async()=>{
  if(process.env.UI_TEST_CONTAINER!=='true')throw Error('OrbStack UI service required');
  const url=new URL(process.env.DATABASE_URL!);url.pathname='/postgres';admin=postgres(url.toString(),{max:1});name=`aidtrace_analytics_ui_${randomBytes(6).toString('hex')}`;await admin`create database ${admin(name)}`;url.pathname='/'+name;connection=connectDatabase(url.toString());
  await migrate(connection.db,{migrationsFolder:'db/migrations'});
  passwords=Object.fromEntries(['maria','tara','ben'].map(user=>[user,randomBytes(18).toString('hex')]));
  await seedFixture(connection.db,{passwords:passwords as Record<'maria'|'tara'|'ben',string>,payeeEmail:'synthetic-ui@personal.example.com',payeeAllowlist:['synthetic-ui@personal.example.com']});
  await connection.db.transaction(tx=>ensureFixtureOpening(tx,'cedar-hollow'));originalHash=await financialHash();
  model=createServer(async(request,response)=>{
    modelCalls++;if(unavailable){response.writeHead(503).end();return;}
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString());const input=JSON.parse(body.messages[0].content);const fact=input.facts[0];
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'msg_ui_stub',type:'message',role:'assistant',model:'claude-haiku-5-5',stop_reason:'end_turn',stop_sequence:null,content:[{type:'text',text:JSON.stringify({selections:[{id:fact.id,quote:fact.text}]})}],usage:{input_tokens:200,output_tokens:30}}));
  });await new Promise<void>(resolve=>model.listen(8080,'0.0.0.0',resolve));
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3100'],{detached:true,stdio:'ignore',env:{...process.env,DATABASE_URL:url.toString(),AI_ANALYTICS_ENABLED:'true',ANTHROPIC_API_KEY:'sk-ant-api03-UI-STUB-NOT-A-REAL-KEY',PAYPAL_CLIENT_ID:'',PAYPAL_CLIENT_SECRET:'',PAYPAL_PRODUCT_WEBHOOK_ENABLED:'false'}});
  for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:3100/api/health',{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}if(server.exitCode!==null)throw Error('Isolated server exited');await new Promise(resolve=>setTimeout(resolve,500));}throw Error('Server readiness timeout');
});
test.afterAll(async()=>{
  if(server?.pid){try{process.kill(-server.pid,'SIGTERM');}catch{}await Promise.race([new Promise(resolve=>server.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);try{process.kill(-server.pid,'SIGKILL');}catch{}}
  await new Promise<void>(resolve=>model?.close(()=>resolve()));await connection?.client.end();if(admin&&/^aidtrace_analytics_ui_[a-f0-9]{12}$/.test(name)){await admin`drop database ${admin(name)} with (force)`;await admin.end();}
});
async function login(page:Page,user:string){await page.goto('/login');await page.getByLabel('Username').fill(user);await page.getByLabel('Password').fill(passwords[user]!);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL(url=>url.pathname==='/');}
async function contained(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);for(const control of await page.locator('.analytics-widget select,.analytics-questions button').all()){await expect(control).toBeVisible();const rect=await control.boundingBox();expect(rect!.x).toBeGreaterThanOrEqual(0);expect(rect!.x+rect!.width).toBeLessThanOrEqual(await page.evaluate(()=>innerWidth));}}
test('AN-07: anonymous and claimant denied; desktop and phone native facts/filter/AI/manual paths preserve financial records',async({page})=>{
  let forbiddenRequests=0;const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(['127.0.0.1','localhost'].includes(url.hostname))return route.continue();forbiddenRequests++;return route.abort();});
  await page.goto('/analytics');await expect(page).toHaveURL(/\/login$/);
  await login(page,'maria');await expect(page.getByRole('link',{name:'View funding and cash'})).toHaveCount(0);await page.goto('/analytics');await expect(page.getByRole('heading',{name:'Approver access required.'})).toBeVisible();expect((await page.request.get('/api/analytics')).status()).toBe(403);
  await page.goto('/');await page.getByRole('button',{name:'Sign out'}).click();await login(page,'tara');await page.getByRole('link',{name:'View funding and cash'}).click();await page.waitForURL(url=>url.pathname==='/analytics');
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});await expect(page.getByTestId('funding-widget')).toBeVisible();await expect(page.getByTestId('cash-widget')).toBeVisible();await contained(page);
    const widget=page.getByTestId('funding-widget');await widget.getByLabel('Show funds').selectOption('RESTRICTED');await expect(widget.getByRole('status')).toHaveText('Visible book balance: $500.00');await widget.getByLabel('Show funds').selectOption('UNRESTRICTED');await expect(widget.getByRole('status')).toHaveText('Visible book balance: $1,000.00');await contained(page);
    await page.getByRole('button',{name:'How does book cash relate to recorded activity?',exact:true}).click();await expect(page.getByTestId('analytics-answer')).toHaveText('Book cash is $1,500.00.');await expect(page.getByTestId('analytics-status')).toHaveText('Verified snapshot facts selected by AI.');await expect(page.getByTestId('analytics-selection')).toHaveText('AI selected 1 of 4 verified facts offered for this question.');
    /* PB-12: an answer that came from the model names it, from the stored id the server returned (the stub serves claude-haiku-5-5). */await expect(page.getByTestId('analytics-powered-by')).toHaveText('Powered by Claude Haiku 5.5.');
    unavailable=true;await page.getByRole('button',{name:'What remains payable?',exact:true}).click();await expect(page.getByTestId('analytics-status')).toContainText('Read the snapshot facts below');await expect(page.getByTestId('analytics-powered-by')).toHaveCount(0);
    await page.getByText('Read all snapshot facts without AI',{exact:true}).click();await expect(page.getByTestId('snapshot-facts')).toContainText('Open reimbursement payable is $0.00.');await contained(page);unavailable=false;
  }
  expect(modelCalls).toBe(4);expect(errors).toEqual([]);expect(forbiddenRequests).toBe(0);expect(await financialHash()).toBe(originalHash);
  const current=await loadAnalyticsSnapshot(connection.db,'tara');const body={question:'cash',snapshotDigest:current.digest};
  const before=modelCalls;expect((await page.request.post('/api/analytics/explain',{data:{...body,question:'send money'},headers:{origin:'http://127.0.0.1:3100'}})).status()).toBe(400);expect(modelCalls).toBe(before);
});
test('AN-F03: native requests admit one call and reject altered, stale and empty facts',async({page})=>{
  await login(page,'ben');await page.goto('/analytics');
  const current=await loadAnalyticsSnapshot(connection.db,'ben');const fact=questionFacts(current,'cash')[0]!;
  let calls=0;let mode:'ready'|'altered'|'stale'|'empty'='ready';let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/analytics/explain',async route=>{
    calls++;if(calls===1)await gate;
    if(mode==='stale')return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'stale'})});
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({snapshotDigest:current.digest,toolsOffered:0,
      facts:mode==='empty'?[]:[mode==='altered'?{...fact,text:'Invented balance $9,999,999.00'}:fact]})});
  });
  const before=modelCalls;
  await page.evaluate(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='How does book cash relate to recorded activity?')!;button.click();button.click();});
  await expect.poll(()=>calls).toBe(1);await expect(page.getByTestId('analytics-status')).toHaveText('Checking snapshot facts...');
  /* CL-E02 (November 10): while the request is held the wait indicator counts real seconds, beside the unchanged status text. */await expect(page.getByTestId('ai-wait')).toBeVisible();await expect(page.getByTestId('ai-wait-time')).toHaveText('1 s',{timeout:10000});
  release();await expect(page.getByTestId('analytics-answer')).toHaveText(fact.text);expect(calls).toBe(1);await expect(page.getByTestId('ai-wait')).toHaveCount(0);
  for(const next of ['altered','stale','empty'] as const){
    mode=next;await page.getByRole('button',{name:'How does book cash relate to recorded activity?',exact:true}).click();
    await expect(page.getByTestId('analytics-status')).toContainText(next==='stale'?'Snapshot changed. Reload':'Read the snapshot facts below');
    await expect(page.getByTestId('analytics-answer')).toBeEmpty();
  }
  expect(calls).toBe(4);expect(modelCalls).toBe(before);expect(await financialHash()).toBe(originalHash);
});
test('FR-24: an approver opens the funder report from analytics and sees its three sections; a claimant gets the access page',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await login(page,'tara');await page.goto('/analytics');
  await page.getByRole('link',{name:'Open the funder report'}).click();await page.waitForURL(url=>url.pathname==='/analytics/report');
  for(const name of ['Funder report.','Spending by decision path','Automation accountability','Kill switch log','What automation can and cannot do'])await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
  await expect(page.getByTestId('report-spending-empty')).toHaveText('No claim has been recognized yet.');
  await expect(page.getByTestId('report-tie-out')).toContainText('Tie-out: the columns total $0.00, which matches the fund debits of the same claims, $0.00.');
  await expect(page.getByTestId('report-accountability-empty')).toBeVisible();await expect(page.getByTestId('report-switch-empty')).toHaveText('The switch has never been turned on. Automation is off.');
  const boundary=page.getByTestId('report-boundary');
  for(const line of ['The AI model can hold a claim but never approves or pays one on its own.','An automatic payment needed every rule to pass and zero compliance flags, under the fund cap.','Sampled and refused claims went to two people.','These are local records, not a PayPal balance.'])await expect(boundary).toContainText(line);
  expect(await page.locator('main form').count()).toBe(0);expect(await page.locator('main button').count()).toBe(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.locator('.report-copy-hint')).toBeVisible();await page.emulateMedia({media:'print'});await expect(page.locator('header.top')).toBeHidden();await expect(page.locator('.report-copy-hint')).toBeHidden();await expect(page.getByRole('heading',{name:'Kill switch log',exact:true})).toBeVisible();await expect(boundary).toBeVisible();await page.emulateMedia({media:'screen'});
  expect(errors).toEqual([]);expect(await financialHash()).toBe(originalHash);
  await page.getByRole('button',{name:'Sign out'}).click();await login(page,'maria');await page.goto('/analytics/report');
  await expect(page.getByRole('heading',{name:'Approver access required.'})).toBeVisible();await expect(page.getByRole('heading',{name:'Spending by decision path'})).toHaveCount(0);
});
