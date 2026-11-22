const express = require('express');
const path = require('path');
const crypto = require('crypto');
const {EventEmitter} = require('events');
const {MongoClient} = require('mongodb');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULTS = [
    'om_dwivedi_0204',
    'anexasvanra',
    'utkarsh_saini23',
    'Divyansh1129',
    'sujal_kumar00710451807',
    'rudransh_bhardwaj'
];

let users = [...DEFAULTS];

const cache = new Map();

const eventBus = new EventEmitter();
eventBus.setMaxListeners(30);
const memory = {players: [], snapshots: [], duels: [], quests: [], league_points: [], reactions: [], messages: [], app_events: [], app_settings: [], playlist: [], sync_logs: []};
let mongoPromise = null;
let webpushPromise = null;
let indexesReady = false;
let usersLoaded = false;
let lastSyncAt = null;
const SETTINGS_DEFAULTS = {_id:'global', notifications:{newAccepted:true,hardSolve:true,overtake:true,duelResult:true,questComplete:true,dailyDigest:true,streakDanger:true}, timezone:process.env.TIMEZONE||'Asia/Kolkata', streakDangerHour:20, sound:false};

async function getDb() {
    if (!process.env.MONGODB_URI) return null;
    if (!mongoPromise) mongoPromise = new MongoClient(process.env.MONGODB_URI, {serverSelectionTimeoutMS:8000, maxPoolSize:5}).connect().then(client => client.db());
    return mongoPromise;
}
async function getWebPush() {
    if (!webpushPromise) webpushPromise = import('web-push').then(module => module.default || module);
    return webpushPromise;
}
function matches(doc, filter) { return Object.entries(filter||{}).every(([k,v]) => doc[k]===v); }
async function storeFind(name, filter={}, limit=0) {
    const db=await getDb();
    if (db) { let q=db.collection(name).find(filter).sort({createdAt:-1}); if(limit)q=q.limit(limit); return q.toArray(); }
    let docs=(memory[name]||[]).filter(d=>matches(d,filter)).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    return limit?docs.slice(0,limit):docs;
}
async function storeInsert(name, doc) {
    const row={...doc,id:doc.id||crypto.randomUUID()};
    const db=await getDb();
    if(db)await db.collection(name).insertOne(row);else (memory[name]||(memory[name]=[])).push(row);
    return row;
}
async function storeUpsert(name, filter, doc) {
    const db=await getDb();
    if(db){await db.collection(name).updateOne(filter,{$set:doc},{upsert:true});return {...filter,...doc};}
    const rows=memory[name]||(memory[name]=[]),i=rows.findIndex(d=>matches(d,filter));
    if(i<0){const row={...filter,...doc,id:crypto.randomUUID()};rows.push(row);return row;}
    rows[i]={...rows[i],...doc};return rows[i];
}
async function storeDelete(name, filter) {
    const db=await getDb();
    if(db)return (await db.collection(name).deleteMany(filter)).deletedCount;
    const rows=memory[name]||[],before=rows.length;memory[name]=rows.filter(d=>!matches(d,filter));return before-memory[name].length;
}
async function ensureIndexes(){if(indexesReady)return;const db=await getDb();if(!db){indexesReady=true;return}await Promise.all([db.collection('players').createIndex({username:1},{unique:true}),db.collection('snapshots').createIndex({username:1,day:1},{unique:true}),db.collection('duels').createIndex({status:1,endAt:1}),db.collection('quests').createIndex({status:1,endAt:1}),db.collection('league_points').createIndex({eventKey:1},{unique:true,sparse:true}),db.collection('reactions').createIndex({activityKey:1,emoji:1,username:1},{unique:true}),db.collection('messages').createIndex({createdAt:-1}),db.collection('push_subscriptions').createIndex({endpoint:1},{unique:true}),db.collection('app_events').createIndex({eventKey:1},{unique:true,sparse:true})]);indexesReady=true;}
function safeEqual(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y)}
function signAdmin(exp){const payload=Buffer.from(JSON.stringify({exp})).toString('base64url');const signature=crypto.createHmac('sha256',process.env.ADMIN_PASSWORD||'').update(payload).digest('base64url');return `${payload}.${signature}`}
function isAdmin(req){const token=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('stalk_admin='))?.slice('stalk_admin='.length);if(!token||!process.env.ADMIN_PASSWORD)return false;const [payload,signature]=token.split('.');if(!safeEqual(signature,crypto.createHmac('sha256',process.env.ADMIN_PASSWORD).update(payload||'').digest('base64url')))return false;try{return JSON.parse(Buffer.from(payload,'base64url').toString()).exp>Date.now()}catch{return false}}
function requireAdmin(req,res,next){if(!process.env.ADMIN_PASSWORD)return res.status(503).json({error:'Set ADMIN_PASSWORD to enable admin access.'});if(!isAdmin(req))return res.status(401).json({error:'Admin login required.'});next()}
async function hydrateUsers(){if(usersLoaded)return;await ensureIndexes();const docs=await storeFind('players');if(docs.length)users=docs.map(x=>x.username);else{for(const username of users)await storeUpsert('players',{username},{username,createdAt:Date.now()})}for(const username of users){const saved=await storeFind('snapshots',{username:username.toLowerCase()},1);if(saved[0]&&!cache.has(username.toLowerCase()))cache.set(username.toLowerCase(),{...saved[0].data,cachedAt:Date.now()})}usersLoaded=true}
async function getSettings(){const found=await storeFind('app_settings',{_id:'global'},1);return found[0]||SETTINGS_DEFAULTS}
async function emitEvent(type,payload={},eventKey=`${type}:${Date.now()}`){const old=await storeFind('app_events',{eventKey},1);if(old.length)return old[0];const event={type,payload,eventKey,createdAt:Date.now()};await storeInsert('app_events',event);for(const listener of eventBus.listeners('app-event'))await listener(event);return event}
async function dispatchAlert(event){try{const settings=await getSettings(),toggle=settings.notifications?.[event.type];if(toggle===false)return;const text=event.payload.text||`${event.type}: ${event.payload.username||'arena update'}`;const sends=[];if(process.env.DISCORD_WEBHOOK_URL)sends.push(fetch(process.env.DISCORD_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:text}),signal:AbortSignal.timeout(5000)}));if(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID)sends.push(fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,text}),signal:AbortSignal.timeout(5000)}));if(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY&&['newAccepted','overtake'].includes(event.type)){const webpush=await getWebPush();webpush.setVapidDetails(process.env.VAPID_SUBJECT||'mailto:admin@stalkmyleetcode.app',process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);const subs=await storeFind('push_subscriptions');for(const sub of subs){try{await webpush.sendNotification(sub.subscription,JSON.stringify({title:'stalkmyleetcode',body:text,url:'/'}))}catch(err){if(err.statusCode===404||err.statusCode===410)await storeDelete('push_subscriptions',{endpoint:sub.endpoint})}}}await Promise.allSettled(sends)}catch(error){console.error('Alert dispatch failed:',error.message)}}
eventBus.on('app-event',event=>dispatchAlert(event));



const QUERY = `query u($u:String!){
  matchedUser(username:$u){
    username
    profile{realName userAvatar ranking}
    submitStatsGlobal{acSubmissionNum{difficulty count}}
    submissionCalendar
    tagProblemCounts{
      advanced{tagName problemsSolved}
      intermediate{tagName problemsSolved}
      fundamental{tagName problemsSolved}
    }
  }
  userContestRanking(username:$u){
    rating attendedContestsCount globalRanking topPercentage
  }
  recentSubmissionList(username:$u,limit:15){
    title titleSlug timestamp statusDisplay lang
  }
}`;

async function fetchUser(name) {

    const r = await fetch('https://leetcode.com/graphql', {
        method: 'POST',

        headers: {
            'Content-Type': 'application/json',
            Referer: 'https://leetcode.com/',
            'User-Agent': 'Mozilla/5.0'
        },

        body: JSON.stringify({
            query: QUERY,
            variables: { u: name }
        }),

        signal: AbortSignal.timeout(10000)
    });

    if (!r.ok) {
        throw new Error('HTTP ' + r.status);
    }

    const { data } = await r.json();

    const m = data && data.matchedUser;

    if (!m) {
        throw new Error('User not found');
    }

    const ac = {};

    m.submitStatsGlobal.acSubmissionNum.forEach(x => {
        ac[x.difficulty] = x.count;
    });

    const cal = JSON.parse(m.submissionCalendar || '{}');

    const now = Date.now() / 1000;
    const day = 86400;
    const today0 = Math.floor(now / day) * day;

    let d1 = 0, d7 = 0, d30 = 0;

    for (const [t, c] of Object.entries(cal)) {

        const age = now - Number(t);

        if (Number(t) >= today0) d1 += c;
        if (age < 7 * day) d7 += c;
        if (age < 30 * day) d30 += c;
    }

    const tags = {};
    const tp = m.tagProblemCounts || {};

    [
        ...(tp.fundamental || []),
        ...(tp.intermediate || []),
        ...(tp.advanced || [])
    ].forEach(t => {
        tags[t.tagName] = t.problemsSolved;
    });

    const cr = data.userContestRanking;

    return {
        username: m.username,
        name: m.profile.realName || m.username,
        avatar: m.profile.userAvatar,
        siteRank: m.profile.ranking,

        total: ac.All || 0,
        easy: ac.Easy || 0,
        medium: ac.Medium || 0,
        hard: ac.Hard || 0,

        rating: cr ? Math.round(cr.rating) : 0,
        contests: cr ? cr.attendedContestsCount : 0,

        today: d1,
        week: d7,
        month: d30,

        tags,
        calendar: cal,
        recent: data.recentSubmissionList || [],
        updated: Date.now()
    };
}

async function refresh(name) {

    const key = name.toLowerCase();

    try {

        const old=cache.get(key);
        const data = await fetchUser(name);
        const day=new Date().toISOString().slice(0,10);
        await storeUpsert('snapshots',{username:key,day},{username:key,day,data,createdAt:Date.now()});
        lastSyncAt=Date.now();
        if(old&&data.hard>(old.hard||0))await emitEvent('hardSolve',{username:name,text:`💀 ${data.name} cleared a Hard problem.`},`hard:${key}:${day}:${data.hard}`);
        if(old){const prior=new Set((old.recent||[]).filter(x=>x.statusDisplay==='Accepted').map(x=>`${x.timestamp}:${x.titleSlug}`));const accepted=(data.recent||[]).find(x=>x.statusDisplay==='Accepted'&&!prior.has(`${x.timestamp}:${x.titleSlug}`));if(accepted)await emitEvent('newAccepted',{username:name,title:accepted.title,text:`⚡ ${data.name} accepted ${accepted.title}.`},`accepted:${key}:${accepted.timestamp}:${accepted.titleSlug}`)}

        cache.set(key, {
            ...data,
            cachedAt: Date.now()
        });

    } catch (e) {
        await storeInsert('sync_logs',{username:name,message:e.message,createdAt:Date.now()}).catch(()=>{});
        const old = cache.get(key) || {
            username: name,
            name,
            total: 0,
            easy: 0,
            medium: 0,
            hard: 0,
            rating: 0,
            today: 0,
            week: 0,
            month: 0,
            tags: {},
            recent: []
        };

        cache.set(key, {
            ...old,
            error: e.message,
            cachedAt: Date.now()
        });
    }
}


// Small in-memory limiter for write and auxiliary routes (per server instance).
const rateBuckets = new Map();
function rateLimit({windowMs = 60000, max = 20} = {}) {
    return (req, res, next) => {
        const forwardedFor = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
        const key = `${forwardedFor || req.ip || req.socket.remoteAddress}:${req.path}`;
        const now = Date.now();
        let bucket = rateBuckets.get(key);
        if (!bucket || now - bucket.start >= windowMs) bucket = {start: now, count: 0};
        bucket.count++;
        rateBuckets.set(key, bucket);
        if (bucket.count > max) return res.status(429).json({error: 'Too many requests. Try again shortly.'});
        next();
    };
}

const DAILY_QUERY = `query daily { activeDailyCodingChallengeQuestion { date link question { title titleSlug difficulty topicTags { name } } } }`;
let dailyCache = {at: 0, value: null};
async function fetchDaily() {
    if (dailyCache.at && Date.now() - dailyCache.at < 6 * 60 * 60 * 1000) return dailyCache.value;
    const response = await fetch('https://leetcode.com/graphql', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Referer: 'https://leetcode.com/', 'User-Agent': 'Mozilla/5.0'},
        body: JSON.stringify({query: DAILY_QUERY}),
        signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('Daily challenge unavailable');
    const json = await response.json();
    dailyCache = {at: Date.now(), value: json.data?.activeDailyCodingChallengeQuestion || null};
    return dailyCache.value;
}

// Connect/hydrate once per serverless instance; health remains available if Atlas is down.
app.use('/api',async(req,res,next)=>{if(req.path==='/health')return next();try{await hydrateUsers();next()}catch(error){res.status(503).json({error:'Storage unavailable',detail:error.message})}});

app.get('/api/health',async(req,res)=>{try{const db=await getDb();await db?.command({ping:1});res.json({ok:true,storage:db?'mongodb':'memory (non-persistent)',players:users.length,lastSyncAt,failedSyncs:(await storeFind('sync_logs',{},10)).length})}catch(error){res.status(503).json({ok:false,error:'Health check failed',detail:error.message})}});
app.post('/api/admin/login',rateLimit({max:5}),async(req,res)=>{if(!process.env.ADMIN_PASSWORD)return res.status(503).json({error:'Admin access is not configured.'});if(!safeEqual(req.body?.password,process.env.ADMIN_PASSWORD))return res.status(401).json({error:'Incorrect password.'});const token=signAdmin(Date.now()+7*86400000),secure=req.secure||req.headers['x-forwarded-proto']==='https'?' Secure;':'';res.setHeader('Set-Cookie',`stalk_admin=${token}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=604800`);res.json({ok:true})});
app.get('/api/admin/status',(req,res)=>res.json({configured:Boolean(process.env.ADMIN_PASSWORD),authenticated:isAdmin(req)}));
app.post('/api/admin/logout',(req,res)=>{res.setHeader('Set-Cookie',`stalk_admin=; HttpOnly;${req.secure||req.headers['x-forwarded-proto']==='https'?' Secure;':''} SameSite=Strict; Path=/; Max-Age=0`);res.json({ok:true})});
app.get('/api/admin/settings',requireAdmin,async(req,res)=>res.json(await getSettings()));
app.put('/api/admin/settings',rateLimit({max:20}),requireAdmin,async(req,res)=>{const cur=await getSettings(),body=req.body||{},next={...cur,notifications:{...cur.notifications,...(body.notifications||{})},timezone:String(body.timezone||cur.timezone).slice(0,64),streakDangerHour:Math.max(0,Math.min(23,Number(body.streakDangerHour??cur.streakDangerHour))),sound:Boolean(body.sound)};await storeUpsert('app_settings',{_id:'global'},next);res.json(next)});
app.get('/api/admin/logs',requireAdmin,async(req,res)=>res.json(await storeFind('sync_logs',{},50)));

// Homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Leaderboard data
app.get('/api/data', async (req, res) => {

    const force = req.query.refresh === '1';

    await Promise.allSettled(
        users.map(async name => {

            const old = cache.get(name.toLowerCase());

            if (force || !old || Date.now() - old.cachedAt > 300000) {
                await refresh(name);
            }

        })
    );

    const result = users.map(name => cache.get(name.toLowerCase())).filter(Boolean).map(({cachedAt,...user})=>user);
    const points=await storeFind('league_points'),totals=new Map();
    for(const row of points)totals.set(row.username,(totals.get(row.username)||0)+row.points);
    result.forEach(user=>{user.leaguePoints=totals.get(user.username.toLowerCase())||0});
    const sorted=[...result].sort((a,b)=>b.total-a.total),todayKey=new Date().toISOString().slice(0,10),oldRows=(await storeFind('snapshots')).filter(x=>x.day<todayKey).sort((a,b)=>b.day.localeCompare(a.day));
    if(oldRows.length){const prevDay=oldRows[0].day,prev=oldRows.filter(x=>x.day===prevDay).sort((a,b)=>(b.data.total||0)-(a.data.total||0));for(let i=0;i<sorted.length;i++){const before=prev.findIndex(x=>x.username===sorted[i].username.toLowerCase());if(before>i&&i<3)await emitEvent('overtake',{username:sorted[i].username,text:`🚀 ${sorted[i].name} overtook a rival and climbed to #${i+1}.`},`overtake:${todayKey}:${sorted[i].username.toLowerCase()}:${i+1}`)}}
    try{const daily=await fetchDaily();for(const user of result)if((user.recent||[]).some(x=>x.statusDisplay==='Accepted'&&x.titleSlug===daily?.question?.titleSlug))await awardPoints(user.username,5,'Solved the daily challenge',`potd:${daily.date}:${user.username.toLowerCase()}`)}catch{}
    res.json(result);
});

// Daily challenge metadata is cached to avoid repeated LeetCode requests.
app.get('/api/extras', rateLimit({max: 12}), async (req, res) => {
    try {
        res.json({daily: await fetchDaily()});
    } catch (error) {
        res.json({daily: dailyCache.value, error: error.message});
    }
});


function streakCount(calendar={}){const days=new Set(Object.keys(calendar).map(t=>new Date(Number(t)*1000).toISOString().slice(0,10))),now=new Date(),today=now.toISOString().slice(0,10),yesterday=new Date(now.getTime()-86400000).toISOString().slice(0,10);let date=days.has(today)?new Date(today+'T12:00:00Z'):days.has(yesterday)?new Date(yesterday+'T12:00:00Z'):null,n=0;while(date&&days.has(date.toISOString().slice(0,10))){n++;date.setUTCDate(date.getUTCDate()-1)}return n}
function profileList(){return users.map(name=>cache.get(name.toLowerCase())).filter(Boolean)}
async function awardPoints(username,points,reason,eventKey){if(await storeFind('league_points',{eventKey},1).then(x=>x.length))return;await storeInsert('league_points',{username:username.toLowerCase(),points,reason,eventKey,createdAt:Date.now()})}
function currentValue(profile,rule){return Number(profile?.[rule==='mediums'?'medium':rule==='hards'?'hard':'total']||0)}
async function duelView(duel){const profiles=profileList(),a=profiles.find(u=>u.username.toLowerCase()===duel.challenger.toLowerCase()),b=profiles.find(u=>u.username.toLowerCase()===duel.opponent.toLowerCase());const metricRule=duel.rule==='firstTo'?'hards':duel.rule;const progressA=Math.max(0,currentValue(a,metricRule)-(duel.baseline?.[duel.challenger.toLowerCase()]||0)),progressB=Math.max(0,currentValue(b,metricRule)-(duel.baseline?.[duel.opponent.toLowerCase()]||0));let winner=duel.winner||null,status=duel.status;if(status==='active'&&(Date.now()>=duel.endAt||(duel.rule==='firstTo'&&Math.max(progressA,progressB)>=duel.target))){winner=progressA===progressB?null:progressA>progressB?duel.challenger:duel.opponent;status='finished';await storeUpsert('duels',{id:duel.id},{...duel,status,winner,finishedAt:Date.now()});if(winner)await awardPoints(winner,30,'Won a duel',`duel:${duel.id}`);await emitEvent('duelResult',{text:winner?`⚔ ${winner} won a duel against ${winner===duel.challenger?duel.opponent:duel.challenger}.`:'⚔ A duel ended in a draw.'},`duel-result:${duel.id}`)}return {...duel,status,winner,progress:{[duel.challenger]:progressA,[duel.opponent]:progressB},profiles:{[duel.challenger]:a?.name||duel.challenger,[duel.opponent]:b?.name||duel.opponent}}}
async function questView(quest){const profiles=profileList(),key=quest.metric==='hards'?'hard':quest.metric==='solved'?'total':quest.metric==='weekly'?'week':'today';const base=Number(quest.baseline||0),value=profiles.reduce((n,u)=>n+(Number(u[key])||0),0),progress=Math.max(0,value-base),contributors=profiles.map(u=>({username:u.username,name:u.name,progress:Math.max(0,(u[key]||0)-(quest.playerBaseline?.[u.username.toLowerCase()]||0))})).filter(x=>x.progress>0);let status=quest.status;if(status==='active'&&Date.now()>=quest.endAt&&progress<quest.target){status='expired';await storeUpsert('quests',{id:quest.id},{...quest,status,expiredAt:Date.now(),progress})}if(status==='active'&&progress>=quest.target){status='completed';await storeUpsert('quests',{id:quest.id},{...quest,status,completedAt:Date.now(),progress});for(const c of contributors)await awardPoints(c.username,10,'Completed a crew quest',`quest:${quest.id}:${c.username.toLowerCase()}`);await emitEvent('questComplete',{text:`🏁 The crew cleared “${quest.title}”!`},`quest-complete:${quest.id}`)}return {...quest,status,progress,contributors}}
app.get('/api/push/key',(req,res)=>{if(!process.env.VAPID_PUBLIC_KEY)return res.status(503).json({error:'Push notifications are not configured.'});res.json({publicKey:process.env.VAPID_PUBLIC_KEY})});
app.post('/api/push/subscribe',rateLimit({max:5}),async(req,res)=>{const subscription=req.body?.subscription;if(!subscription?.endpoint||!subscription?.keys?.p256dh||!subscription?.keys?.auth)return res.status(400).json({error:'Invalid push subscription.'});await storeUpsert('push_subscriptions',{endpoint:subscription.endpoint},{endpoint:subscription.endpoint,subscription,createdAt:Date.now()});res.json({ok:true})});
app.get('/api/events',async(req,res)=>res.json(await storeFind('app_events',{},25)));
app.get('/api/duels',async(req,res)=>{const rows=await storeFind('duels');res.json(await Promise.all(rows.map(duelView)))});
app.post('/api/duels',rateLimit({max:8}),async(req,res)=>{const {challenger,opponent}=req.body||{},rule=String(req.body?.rule||'mediums'),target=Math.max(1,Math.min(100,Number(req.body?.target)||5)),days=Math.max(1,Math.min(30,Number(req.body?.days)||7));if(!users.some(x=>x.toLowerCase()===String(challenger).toLowerCase())||!users.some(x=>x.toLowerCase()===String(opponent).toLowerCase())||String(challenger).toLowerCase()===String(opponent).toLowerCase())return res.status(400).json({error:'Choose two different players in the arena.'});if(!['mediums','hards','solved','firstTo'].includes(rule))return res.status(400).json({error:'Unknown duel rule.'});const baseline=Object.fromEntries(profileList().map(u=>[u.username.toLowerCase(),currentValue(u,rule==='firstTo'?'hards':rule)]));const row={challenger,opponent,rule,target,startAt:Date.now(),endAt:Date.now()+days*86400000,baseline,status:'active',createdAt:Date.now()};const saved=await storeInsert('duels',row);res.status(201).json(saved)});
app.get('/api/duels/history/:username',async(req,res)=>{const rows=await storeFind('duels');res.json(await Promise.all(rows.filter(d=>[d.challenger,d.opponent].some(n=>n.toLowerCase()===req.params.username.toLowerCase())).map(duelView)))});
app.get('/api/quests',async(req,res)=>{const rows=await storeFind('quests');res.json(await Promise.all(rows.map(questView)))});
app.post('/api/quests',rateLimit({max:10}),requireAdmin,async(req,res)=>{const title=String(req.body?.title||'').trim().slice(0,80),metric=String(req.body?.metric||'weekly'),target=Math.max(1,Math.min(10000,Number(req.body?.target)||100)),days=Math.max(1,Math.min(30,Number(req.body?.days)||7));if(!title||!['weekly','hards','solved','today'].includes(metric))return res.status(400).json({error:'Provide a title and valid quest metric.'});const key=metric==='hards'?'hard':metric==='solved'?'total':metric==='weekly'?'week':'today',profiles=profileList(),saved=await storeInsert('quests',{title,metric,target,baseline:profiles.reduce((n,u)=>n+(u[key]||0),0),playerBaseline:Object.fromEntries(profiles.map(u=>[u.username.toLowerCase(),u[key]||0])),startAt:Date.now(),endAt:Date.now()+days*86400000,status:'active',createdAt:Date.now()});res.status(201).json(saved)});
app.delete('/api/quests/:id',requireAdmin,async(req,res)=>{await storeUpsert('quests',{id:req.params.id},{status:'cancelled',cancelledAt:Date.now()});res.json({ok:true})});
app.get('/api/league',async(req,res)=>{const rows=await storeFind('league_points'),totals=new Map();for(const r of rows)totals.set(r.username,(totals.get(r.username)||0)+r.points);res.json(profileList().map(u=>({username:u.username,name:u.name,points:totals.get(u.username.toLowerCase())||0})).sort((a,b)=>b.points-a.points))});
app.get('/api/snapshots',async(req,res)=>{const from=String(req.query.from||'').slice(0,10),to=String(req.query.to||'').slice(0,10),rows=await storeFind('snapshots');res.json(rows.filter(x=>(!from||x.day>=from)&&(!to||x.day<=to)).sort((a,b)=>a.day.localeCompare(b.day)).slice(-370))});
app.get('/api/timemachine',async(req,res)=>{const day=String(req.query.day||'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(day))return res.status(400).json({error:'Provide a date as YYYY-MM-DD.'});const rows=await storeFind('snapshots'),latest=new Map();for(const row of rows.filter(x=>x.day<=day).sort((a,b)=>a.day.localeCompare(b.day)))latest.set(row.username,row);res.json(users.map(name=>latest.get(name.toLowerCase())?.data).filter(Boolean))});
app.get('/api/export',async(req,res)=>{const type=String(req.query.format||'json').toLowerCase(),data=profileList();if(type==='csv'){res.type('text/csv').attachment('stalkmyleetcode-leaderboard.csv').send(['username,name,total,easy,medium,hard,rating,today,week,month',...data.map(u=>[u.username,u.name,u.total,u.easy,u.medium,u.hard,u.rating,u.today,u.week,u.month].map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(','))].join('\n'));return}if(type!=='json')return res.status(400).json({error:'format must be csv or json'});res.attachment('stalkmyleetcode-export.json').json({exportedAt:new Date().toISOString(),players:data,snapshots:await storeFind('snapshots')})});
app.get('/api/badge/:username.svg',async(req,res)=>{const u=profileList().find(x=>x.username.toLowerCase()===req.params.username.toLowerCase());if(!u)return res.status(404).type('text/plain').send('Unknown player');const rank=[...profileList()].sort((a,b)=>b.total-a.total).findIndex(x=>x.username===u.username)+1,streak=streakCount(u.calendar||{}),name=String(u.name||u.username).replace(/[&<>"']/g,'').slice(0,22),svg=`<svg xmlns="http://www.w3.org/2000/svg" width="330" height="38" role="img" aria-label="${name}: rank ${rank}, ${u.total} solved"><title>${name} · rank ${rank} · ${u.total} solved</title><rect width="330" height="38" rx="8" fill="#12151D"/><text x="13" y="24" fill="#E8ECF4" font-family="Arial" font-size="13">${name}</text><text x="188" y="24" fill="#C6F135" font-family="Arial" font-size="12">#${rank} · ${u.total} solved · ${streak}🔥</text></svg>`;res.type('image/svg+xml').set('Cache-Control','public, max-age=300, s-maxage=300').send(svg)});
app.get('/api/users/:username/insights',async(req,res)=>{const u=profileList().find(x=>x.username.toLowerCase()===req.params.username.toLowerCase());if(!u)return res.status(404).json({error:'Player not found'});const recent=u.recent||[],accepted=recent.filter(x=>x.statusDisplay==='Accepted'),langs={},hours=Array(24).fill(0),weekdays=Array(7).fill(0),days=Object.entries(u.calendar||{}).map(([t,n])=>({date:new Date(Number(t)*1000),count:Number(n)})),active30=days.filter(x=>Date.now()-x.date.getTime()<30*86400000),tagEntries=Object.entries(u.tags||{}).sort((a,b)=>a[1]-b[1]),weak=tagEntries.slice(0,3),strong=tagEntries.slice(-3).reverse();for(const r of recent){langs[r.lang]=(langs[r.lang]||0)+1;const time=new Date(Number(r.timestamp)*1000),parts=new Intl.DateTimeFormat('en-US',{timeZone:process.env.TIMEZONE||'Asia/Kolkata',hour:'2-digit',hourCycle:'h23',weekday:'long'}).formatToParts(time),h=Number(parts.find(x=>x.type==='hour')?.value||0),wd=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].indexOf(parts.find(x=>x.type==='weekday')?.value);hours[h]++;if(wd>=0)weekdays[wd]++}const activeCounts=active30.map(x=>x.count),mean=activeCounts.reduce((a,b)=>a+b,0)/(activeCounts.length||1),variance=activeCounts.reduce((a,b)=>a+(b-mean)**2,0)/(activeCounts.length||1),streak=Math.min(30,Object.keys(u.calendar||{}).length);const score=Math.round(Math.min(100,active30.length/30*65+Math.min(30,streakCount(u.calendar||{}))/30*25+Math.max(0,10-Math.sqrt(variance))*1)),history=(await storeFind('snapshots',{username:u.username.toLowerCase()})).sort((a,b)=>a.day.localeCompare(b.day)),old=history.filter(x=>Date.now()-new Date(x.day+'T23:59:59Z').getTime()<=30*86400000).at(0),pace=old?Math.max(0,(u.total||0)-(old.data.total||0))/Math.max(1,(Date.now()-new Date(old.day+'T23:59:59Z').getTime())/86400000):0,milestones=[100,250,500,1000].filter(n=>n>(u.total||0)).map(n=>({total:n,days:pace?Math.ceil((n-u.total)/pace):null,date:pace?new Date(Date.now()+Math.ceil((n-u.total)/pace)*86400000).toISOString().slice(0,10):null}));const fav=Object.entries(langs).sort((a,b)=>b[1]-a[1])[0],hour=hours.indexOf(Math.max(...hours)),weekday=weekdays.indexOf(Math.max(...weekdays));res.json({acceptanceRate:recent.length?Math.round(accepted.length/recent.length*100):0,firstTryRate:recent.length?Math.round((()=>{const attempts=[...recent].sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)),first=new Map();for(const r of attempts)if(!first.has(r.titleSlug))first.set(r.titleSlug,r.statusDisplay==='Accepted');return [...first.values()].filter(Boolean).length/Math.max(1,first.size)*100})()):0,favoriteLanguage:fav?.[0]||'—',productiveHour:hour,productiveWeekday:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][weekday],averagePerActiveDay:active30.length?Number((activeCounts.reduce((a,b)=>a+b,0)/active30.length).toFixed(1)):0,consistency:score,activeDays30:active30.length,weakTopics:weak,strongTopics:strong,milestones,recommendation:weak[0]?.[0]||'Keep exploring'})});
app.get('/api/help',async(req,res)=>{const q=String(req.query.q||'').trim().toLowerCase().slice(0,100);if(q.length<2)return res.status(400).json({error:'Search with at least two characters.'});const result=profileList().flatMap(u=>(u.recent||[]).filter(r=>r.statusDisplay==='Accepted'&&(`${r.title} ${r.titleSlug}`.toLowerCase().includes(q))).map(r=>({username:u.username,name:u.name,title:r.title,titleSlug:r.titleSlug,lang:r.lang,timestamp:r.timestamp})));res.json(result)});
app.get('/api/recommendations/:username',async(req,res)=>{const u=profileList().find(x=>x.username.toLowerCase()===req.params.username.toLowerCase());if(!u)return res.status(404).json({error:'Player not found'});const weak=Object.entries(u.tags||{}).sort((a,b)=>a[1]-b[1]).slice(0,3);res.json({username:u.username,topics:weak.map(([name,solved])=>({name,solved,url:`https://leetcode.com/tag/${encodeURIComponent(name.toLowerCase().replaceAll(' ','-'))}/`})),level:(u.rating||0)>1800?'Hard':(u.rating||0)>1400?'Medium':'Easy',note:'Pick an unsolved problem from these focus areas on LeetCode.'})});
app.get('/api/reactions',async(req,res)=>{const keys=String(req.query.keys||'').split(',').filter(Boolean).slice(0,50),docs=await storeFind('reactions');res.json(docs.filter(d=>keys.includes(d.activityKey)))});
app.post('/api/reactions',rateLimit({max:40}),async(req,res)=>{const {activityKey,emoji,reactor}=req.body||{};if(!/^[\w:@./-]{1,180}$/.test(String(activityKey||''))||!['🔥','👏','💀','😭'].includes(emoji))return res.status(400).json({error:'Invalid reaction.'});const who=String(reactor||'guest').slice(0,40),filter={activityKey,emoji,reactor:who},existing=await storeFind('reactions',filter,1);if(existing.length)await storeDelete('reactions',filter);else await storeInsert('reactions',{...filter,createdAt:Date.now()});res.json({ok:true,active:!existing.length})});
app.get('/api/messages',async(req,res)=>res.json((await storeFind('messages',{},60)).filter(x=>!x.deletedAt)));
app.post('/api/messages',rateLimit({max:5}),async(req,res)=>{const text=String(req.body?.text||'').trim().slice(0,200),name=String(req.body?.name||'Coder').trim().slice(0,32);if(!text)return res.status(400).json({error:'Message can’t be empty.'});if(/\b(fuck|shit|bitch|asshole|cunt|n[i1]gg)\b/i.test(text))return res.status(400).json({error:'Please keep it friendly.'});const message=await storeInsert('messages',{text,name,createdAt:Date.now()});res.status(201).json(message)});
app.delete('/api/messages/:id',requireAdmin,async(req,res)=>{await storeUpsert('messages',{id:req.params.id},{deletedAt:Date.now()});res.json({ok:true})});
app.get('/api/playlist',async(req,res)=>{const list=await storeFind('playlist'),profiles=profileList();res.json(list.map(item=>({...item,solvers:profiles.filter(u=>(u.recent||[]).some(r=>r.statusDisplay==='Accepted'&&r.titleSlug===item.titleSlug)).map(u=>u.username),solverDetails:profiles.flatMap(u=>(u.recent||[]).filter(r=>r.statusDisplay==='Accepted'&&r.titleSlug===item.titleSlug).map(r=>({username:u.username,name:u.name,timestamp:r.timestamp}))).sort((a,b)=>a.timestamp-b.timestamp)})))});
app.post('/api/playlist',rateLimit({max:15}),requireAdmin,async(req,res)=>{const url=String(req.body?.url||''),match=url.match(/leetcode\.com\/problems\/([a-z0-9-]+)/i);if(!match)return res.status(400).json({error:'Provide a LeetCode problem URL.'});const slug=match[1],row=await storeInsert('playlist',{titleSlug:slug,title:String(req.body?.title||slug).slice(0,100),createdAt:Date.now()});res.status(201).json(row)});
app.delete('/api/playlist/:id',requireAdmin,async(req,res)=>{await storeDelete('playlist',{id:req.params.id});res.json({ok:true})});

// Secured scheduled sync. Vercel cron sends Authorization: Bearer <CRON_SECRET>.
app.all('/api/cron/sync', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    const supplied = String(req.get('authorization') || req.get('x-cron-secret') || '').replace(/^Bearer\s+/i, '');
    const provided = Buffer.from(supplied);
    const expected = Buffer.from(secret || '');
    if (!secret || provided.length !== expected.length || !require('crypto').timingSafeEqual(provided, expected)) {
        return res.status(401).json({error: 'Unauthorized'});
    }
    let synced = 0;
    await Promise.all(users.map((name, index) => new Promise(resolve => {
        setTimeout(async () => {
            await refresh(name);
            synced++;
            resolve();
        }, index * 250);
    })))
    const settings=await getSettings();
    if(settings.notifications?.dailyDigest!==false)await emitEvent('dailyDigest',{text:`📊 Daily digest: synced ${synced} players; ${profileList().reduce((n,u)=>n+(u.today||0),0)} submissions today.`},`digest:${new Date().toISOString().slice(0,10)}`);
    const localWeekday=new Intl.DateTimeFormat('en-US',{timeZone:settings.timezone||'Asia/Kolkata',weekday:'long'}).format(new Date());
    if(localWeekday==='Monday'){const winner=[...profileList()].sort((a,b)=>(b.week||0)-(a.week||0))[0];if(winner)await awardPoints(winner.username,50,'Weekly leaderboard #1',`weekly-win:${new Date().toISOString().slice(0,10)}`)}
    res.json({ok: true, synced, at: new Date().toISOString()});
});

app.all('/api/cron/reminders',async(req,res)=>{const secret=process.env.CRON_SECRET,supplied=String(req.get('authorization')||req.get('x-cron-secret')||'').replace(/^Bearer\s+/i,''),provided=Buffer.from(supplied),expected=Buffer.from(secret||'');if(!secret||provided.length!==expected.length||!crypto.timingSafeEqual(provided,expected))return res.status(401).json({error:'Unauthorized'});const settings=await getSettings(),zone=settings.timezone||'Asia/Kolkata',now=new Date(),localParts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now),hour=Number(localParts.find(x=>x.type==='hour')?.value||0),day=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);if(hour<settings.streakDangerHour)return res.json({ok:true,skipped:'before reminder hour',timezone:zone});const atRisk=profileList().filter(u=>u.today===0&&streakCount(u.calendar||{})>=3).map(u=>u.name);if(atRisk.length&&settings.notifications?.streakDanger!==false)await emitEvent('streakDanger',{text:`🔥 Streak check (${zone}): no submissions today yet from ${atRisk.join(', ')}.`},`streak-danger:${day}`);res.json({ok:true,atRisk:atRisk.length,timezone:zone})});

// Add user
app.post('/api/users', rateLimit({max: 10}), requireAdmin, async (req, res) => {

    const name = String(req.body.username || '').trim();

    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) {
        return res.status(400).json({
            error: 'Bad username'
        });
    }

    if (users.some(u => u.toLowerCase() === name.toLowerCase())) {
        return res.status(400).json({
            error: 'Already added'
        });
    }

    try {

        const data = await fetchUser(name);

        users.push(name);
        await storeUpsert('players',{username:name},{username:name,createdAt:Date.now()});

        cache.set(name.toLowerCase(), {
            ...data,
            cachedAt: Date.now()
        });

        res.json({ ok: true });

    } catch (e) {

        res.status(404).json({
            error: e.message
        });
    }
});

// Remove user
app.delete('/api/users/:username', rateLimit({max: 10}), requireAdmin, async (req, res) => {

    const username=req.params.username;
    const name=username.toLowerCase();
    users=users.filter(u=>u.toLowerCase()!==name);
    cache.delete(name);
    await storeDelete('players',{username});

    res.json({ ok: true });
});

// Export app for Vercel
module.exports = app;

// Run locally
if (require.main === module) {

    const PORT = process.env.PORT || 3000;

    app.listen(PORT, () => {
        console.log(`Leaderboard running at http://localhost:${PORT}`);
    });
}
