const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const Module=require('node:module');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');const test=require('node:test');
test('extension retains uncertain lock across calls and only explicit acknowledgement releases it',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'odoo-rpc-ui-'));const settings=path.join(dir,'.vscode');const storage=path.join(dir,'storage');fs.mkdirSync(settings);
 fs.writeFileSync(path.join(settings,'odoo-update.json'),JSON.stringify({version:1,profiles:{dev:{type:'local',python:'python3',odooBin:'/odoo-bin',config:'/odoo.conf',database:'demo',updateMode:'rpc',serverUrl:'http://127.0.0.1:8069',login:'admin'}}}));
 const commands=new Map(),state=new Map(),secrets=new Map(),messages=[];let calls=0,ambiguous=true,confirm=false;
 const disposable=()=>({dispose(){}});
 const vscode={workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:dir}}],onDidSaveTextDocument:disposable},StatusBarAlignment:{Left:1},ProgressLocation:{Notification:1},EventEmitter:class{constructor(){this.event=()=>{};}fire(){}dispose(){}},commands:{registerCommand(id,cb){commands.set(id,cb);return disposable();}},window:{createOutputChannel:()=>({show(){},append(){},appendLine(){},dispose(){}}),createStatusBarItem:()=>({show(){},hide(){},dispose(){}}),registerTreeDataProvider:disposable,async showQuickPick(items){return items[0];},async showInputBox(){return 'secret';},showInformationMessage(){},showWarningMessage(_s,_opts,yes){return confirm?yes:undefined;},showErrorMessage(s){messages.push(s);},withProgress:(_o,cb)=>cb()}};
 const original=Module._load;
 Module._load=function(id,...args){
  if(id==='vscode')return vscode;
  if(id==='./rpc')return{connectionKey:(p,db)=>JSON.stringify([p.serverUrl,db,p.login]),OdooRpc:class{constructor(){this.sessions=new Map();}forget(){}async authenticate(){}async upgrade(_p,_d,_m,getPassword){calls++;await getPassword();if(ambiguous)throw Object.assign(new Error('timeout'),{uncertain:true});}}};
  if(id==='node:child_process')return{spawn(){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.stdin.on('finish',()=>setImmediate(()=>{const addon={name:'custom',title:'Custom',state:'installed',available:true,installable:true,path:'/custom',kind:'extra'};child.stdout.end(JSON.stringify({ok:true,result:{modules:[addon],plan:[addon]}}));child.emit('close',0);}));return child;}};
  return original.call(this,id,...args);
 };
 try{
  delete require.cache[require.resolve('../src/extension')];
  require('../src/extension').activate({subscriptions:[],globalStorageUri:{fsPath:storage},asAbsolutePath:f=>path.resolve(__dirname,'..',f),workspaceState:{get:(k,f)=>state.get(k)??f,update:async(k,v)=>state.set(k,v)},secrets:{get:async k=>secrets.get(k),store:async(k,v)=>secrets.set(k,v),delete:async k=>secrets.delete(k)}});
  await new Promise(r=>setImmediate(r));
  await commands.get('odooUpdate.update')();assert.equal(calls,1);assert.equal(secrets.size,1);
  const lock=path.join(storage,fs.readdirSync(storage)[0]);assert.equal(JSON.parse(fs.readFileSync(lock)).state,'uncertain');assert(messages.some(s=>s.includes('Исход обновления неизвестен')));
  await commands.get('odooUpdate.update')();assert.equal(calls,1);
  await commands.get('odooUpdate.clearUncertain')();assert(fs.existsSync(lock));
  confirm=true;await commands.get('odooUpdate.clearUncertain')();assert(!fs.existsSync(lock));
  ambiguous=false;await commands.get('odooUpdate.update')();assert.equal(calls,2);assert.deepEqual(fs.readdirSync(storage),[]);
 }finally{Module._load=original;fs.rmSync(dir,{recursive:true});}
});
