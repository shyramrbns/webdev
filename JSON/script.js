const $ = (id) => document.getElementById(id);
const COLORS = { easy: "#3dffa0", medium: "#4cc9ff", hard: "#ffb020", extreme: "#ff4d6d" };
let data, levelKey = "easy", quiz = [], idx = 0, score = 0, missed = [];
let answered = false, timerId, runStart;

(function () {
    const sym = ["{ }", "</>", ";", "=>", "( )", "#", "[ ]", "//", "&&", "!=", "<?>", "*"];
    const cols = ["#c6ff3d", "#4cc9ff", "#ffb020", "#ff4d6d", "#3dffa0"];
    for (let i = 0; i < 20; i++) {
        const s = document.createElement("span");
        s.textContent = sym[i % sym.length];
        s.style.left = (i % 2 ? Math.random() * 10 : 89 + Math.random() * 8) + "vw";
        s.style.top = Math.random() * 100 + "vh";
        s.style.color = cols[i % cols.length];
        s.style.fontSize = 1.1 + Math.random() * 1.8 + "rem";
        s.style.animationDuration = 6 + Math.random() * 8 + "s";
        s.style.animationDelay = -Math.random() * 10 + "s";
        $("deco").append(s);
    }
})();

fetch("data.json")
    .then((r) => { if (!r.ok) throw 0; return r.json(); })
    .then((d) => {
        data = d;
        const total = Object.values(d.questions).reduce((n, l) => n + l.length, 0);
        $("facts").textContent = `${total} questions | ${Object.keys(d.levels).length} levels | beat the clock`;
        view("home");
    })
    .catch(() => ($("error").hidden = false));

function view(id) {
    ["home", "levels", "quiz", "result"].forEach((v) => ($(v).hidden = v !== id));
    if (id === "levels") buildLevels();
    window.scrollTo(0, 0);
}
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const mmss = (ms) => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

function fmt(el, text) {
    el.textContent = "";
    text.split("`").forEach((p, n) => {
        if (n % 2) { const c = document.createElement("code"); c.textContent = p; el.append(c); }
        else el.append(p);
    });
}

const getRec = (k) => { try { return JSON.parse(localStorage.getItem("ss-" + k)) || {}; } catch { return {}; } };
const setRec = (k, r) => { try { localStorage.setItem("ss-" + k, JSON.stringify(r)); } catch { } };

$("start").onclick = () => view("levels");
$("back-home").onclick = () => view("home");
$("menu").onclick = () => view("levels");
$("home-btn").onclick = () => view("home");
$("retry").onclick = () => start(levelKey);
$("quit").onclick = () => { clearInterval(timerId); view("levels"); };

function buildLevels() {
    const box = $("grid");
    box.innerHTML = "";
    Object.entries(data.levels).forEach(([key, lv]) => {
        const rec = getRec(key);
        const b = document.createElement("button");
        b.className = "level";
        b.style.setProperty("--c", COLORS[key] || "var(--brand)");
        b.innerHTML = `<h3></h3><p></p><div class="tags"></div><div class="best"></div>`;
        b.querySelector("h3").textContent = lv.label;
        b.querySelector("p").textContent = lv.info;
        [`${lv.seconds}s per question`, `Pass ${lv.passPercent}%`].forEach((t) => {
            const s = document.createElement("span"); s.textContent = t; b.querySelector(".tags").append(s);
        });
        b.querySelector(".best").textContent = rec.score != null
            ? `Highest: ${rec.score}/${rec.total}` + (rec.fastest ? `  |  Fastest pass: ${mmss(rec.fastest)}` : "")
            : "No record yet. Set the first one!";
        b.onclick = () => start(key);
        box.append(b);
    });
}

function start(key) {
    levelKey = key;
    const pool = data.questions[key];
    quiz = shuffle(pool).slice(0, Math.min(data.maxQuestions || 15, pool.length)).map((it) => ({
        ...it,
        choices: shuffle(it.choices.map((t, i) => ({ t, ok: i === it.answer })))
    }));
    idx = 0; score = 0; missed = []; runStart = Date.now();
    view("quiz");
    show();
}

function show() {
    const lv = data.levels[levelKey], it = quiz[idx];
    answered = false;
    $("qcount").textContent = `${lv.label} | ${idx + 1} of ${quiz.length}`;
    $("live").textContent = `Score: ${score}`;
    $("lang").hidden = !it.lang;
    $("lang").textContent = it.lang || "";
    fmt($("question"), it.q);
    $("code").hidden = !it.code;
    $("code").firstChild.textContent = it.code || "";
    $("feedback").hidden = true;
    $("choices").innerHTML = "";
    it.choices.forEach((c, n) => {
        const b = document.createElement("button");
        b.className = "choice";
        const k = document.createElement("span"); k.className = "k"; k.textContent = n + 1;
        const t = document.createElement("span"); fmt(t, c.t);
        b.append(k, t);
        b.onclick = () => pick(n);
        $("choices").append(b);
    });
    timer(lv.seconds);
}

function timer(sec) {
    clearInterval(timerId);
    const end = Date.now() + sec * 1000;
    const tick = () => {
        const left = end - Date.now();
        $("fill").style.width = Math.max(0, (left / (sec * 1000)) * 100) + "%";
        $("clock").textContent = Math.max(0, Math.ceil(left / 1000)) + "s";
        const low = left <= 4000;
        $("fill").classList.toggle("low", low);
        $("clock").classList.toggle("low", low);
        if (left <= 0) { clearInterval(timerId); pick(-1); }
    };
    tick();
    timerId = setInterval(tick, 100);
}

function pick(n) {
    if (answered) return;
    answered = true;
    clearInterval(timerId);
    const it = quiz[idx], right = it.choices.findIndex((c) => c.ok), good = n === right;
    [...$("choices").children].forEach((b, i) => {
        b.classList.add("lock");
        b.classList.add(i === right ? "ok" : i === n ? "no" : "dim");
    });
    if (good) score++;
    else missed.push({ q: it.q, a: it.choices[right].t, late: n === -1 });
    $("live").textContent = `Score: ${score}`;
    $("ftitle").textContent = good ? "Correct!" : n === -1 ? "Time's up." : "Not quite.";
    $("ftitle").className = good ? "y" : "n";
    fmt($("ftext"), it.explain || "");
    $("next").textContent = idx === quiz.length - 1 ? "See results" : "Next question";
    $("feedback").hidden = false;
    $("next").focus();
}

$("next").onclick = () => (idx === quiz.length - 1 ? finish() : (idx++, show()));
document.addEventListener("keydown", (e) => {
    if ($("quiz").hidden || answered) return;
    const n = Number(e.key) - 1;
    if (n >= 0 && n < quiz[idx].choices.length) pick(n);
});

function finish() {
    const lv = data.levels[levelKey], total = quiz.length, time = Date.now() - runStart;
    const pct = Math.round((score / total) * 100);
    const need = Math.max(1, Math.ceil((total * lv.passPercent) / 100));
    const passed = score >= need;
    view("result");

    $("stamp").textContent = passed ? "PASSED" : "FAILED";
    $("stamp").className = "stamp " + (passed ? "pass" : "fail");
    $("big").textContent = `${score} / ${total}`;
    $("msg").textContent = passed
        ? pct === 100 ? "Perfect score! Not a single mistake." : "Great job! You passed this level."
        : `You needed ${need} correct to pass. Check the missed ones and try again.`;

    const rec = getRec(levelKey);
    const betterScore = rec.score == null || pct > Math.round((rec.score / rec.total) * 100);
    const faster = passed && (!rec.fastest || time < rec.fastest);
    const isRecord = total >= 5 && (betterScore || faster);
    if (total >= 5) {
        if (betterScore) { rec.score = score; rec.total = total; }
        if (faster) rec.fastest = time;
        setRec(levelKey, rec);
    }
    $("record").hidden = !isRecord;
    if (isRecord) confetti();

    const stats = [
        ["Level", lv.label], ["Percent", pct + "%"], ["Needed to pass", `${need} / ${total}`],
        ["Your time", mmss(time)],
        ["Highest score", rec.score != null ? `${rec.score} / ${rec.total}` : "-"],
        ["Fastest pass", rec.fastest ? mmss(rec.fastest) : "-"]
    ];
    $("stats").innerHTML = "";
    stats.forEach(([a, b]) => {
        const d = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = a; dd.textContent = b; d.append(dt, dd); $("stats").append(d);
    });

    $("missed").innerHTML = "";
    missed.forEach((m) => {
        const li = document.createElement("li"), q = document.createElement("div"), a = document.createElement("div");
        fmt(q, m.q + (m.late ? " (time ran out)" : ""));
        a.className = "ans"; fmt(a, "Answer: " + m.a);
        li.append(q, a); $("missed").append(li);
    });
    $("missed-box").hidden = !missed.length;
}

function confetti() {
    const colors = ["#c6ff3d", "#4cc9ff", "#ffd166", "#ff4d6d"];
    for (let i = 0; i < 40; i++) {
        const s = document.createElement("span");
        s.className = "conf";
        s.style.left = Math.random() * 100 + "vw";
        s.style.background = colors[i % 4];
        s.style.animationDelay = Math.random() * 0.6 + "s";
        document.body.append(s);
        setTimeout(() => s.remove(), 3200);
    }
}