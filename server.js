const express = require('express');
const path = require('path');

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
        recent: data.recentSubmissionList || [],
        updated: Date.now()
    };
}

async function refresh(name) {

    const key = name.toLowerCase();

    try {

        const data = await fetchUser(name);

        cache.set(key, {
            ...data,
            cachedAt: Date.now()
        });

    } catch (e) {

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

            if (force || !old || Date.now() - old.cachedAt > 15000) {
                await refresh(name);
            }

        })
    );

    const result = users
        .map(name => cache.get(name.toLowerCase()))
        .filter(Boolean)
        .map(({ cachedAt, ...user }) => user);

    res.json(result);
});

// Add user
app.post('/api/users', async (req, res) => {

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
app.delete('/api/users/:username', (req, res) => {

    const name = req.params.username.toLowerCase();

    users = users.filter(
        u => u.toLowerCase() !== name
    );

    cache.delete(name);

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
