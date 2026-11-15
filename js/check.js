// 動作確認画面：このブラウザで各機能が使えるかを調べて一覧にする。
// 開いただけでは何もダウンロード・送信しない。モデルのダウンロードは「テスト」ボタンを押したときだけ行う。
// 会社PCでファイルを直接開いても（file://）動くよう、ESモジュールにはしない。

const $ = id => document.getElementById(id);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const STATE_LABEL = { ok: '○', warn: '△', err: '×', info: '－' };
const groups = [];       // {title, rows:[row]}
const extraResults = []; // 音声認識テストなど、ボタンで実行した結果

function toast(text, durationMs = 3000) {
  const m = $('msg'); m.textContent = text; m.style.display = 'block';
  clearTimeout(m._t); m._t = setTimeout(() => (m.style.display = 'none'), durationMs);
}

const since = (t0, t1 = performance.now()) => `${Math.round(t1 - t0)}ミリ秒`;

// 応答が返ってこない場合に備えて時間切れを設ける
function withTimeout(promise, sec = 15) {
  let timer;
  const limit = new Promise((_, ng) => { timer = setTimeout(() => ng(new Error(`${sec}秒たっても応答がありません`)), sec * 1000); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// 「進みがない時間」で打ち切る見張り役。ダウンロードの進捗が来るたびに kick() で延長する
function watchdog(sec) {
  let timer, fail;
  const tripped = new Promise((_, ng) => { fail = ng; });
  tripped.catch(() => {}); // 誰も待っていないときの未処理エラーを防ぐ
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error(`${sec}秒間進みがないため打ち切りました`)), sec * 1000); };
  kick();
  return { race: p => Promise.race([p, tripped]), kick, stop: () => clearTimeout(timer) };
}

// ---------- 表示の部品 ----------
function makeRow(name) {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td class="name"></td><td class="state"><span class="dot"></span><b></b></td><td class="detail"><div class="txt"></div></td>';
  tr.querySelector('.name').textContent = name;
  const row = {
    name, state: 'info', label: '確認中…', detail: '', el: tr,
    set(state, label, detail = '') {
      Object.assign(row, { state, label, detail });
      tr.querySelector('.dot').className = 'dot ' + (state === 'info' ? '' : state);
      tr.querySelector('b').textContent = label;
      tr.querySelector('.txt').textContent = detail;
    },
    addButton(label, run) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = async () => { b.disabled = true; try { await run(); } finally { b.disabled = false; } };
      tr.querySelector('.detail').appendChild(b);
    },
  };
  row.set('info', '確認中…');
  return row;
}

function makeGroup(title) {
  const sec = document.createElement('section');
  sec.className = 'card';
  sec.innerHTML = '<h2></h2><table><tbody></tbody></table>';
  sec.querySelector('h2').textContent = title;
  $('groups').appendChild(sec);
  const g = { title, rows: [], add(name) { const r = makeRow(name); g.rows.push(r); sec.querySelector('tbody').appendChild(r.el); return r; } };
  groups.push(g);
  return g;
}

const AI_UNAVAILABLE = 'このPC・ブラウザでは使えません。考えられる原因: ブラウザが古い（日本語に未対応）／PCの性能が要件に届かない／管理者がポリシーで止めている。';

// 内蔵AIの availability() の戻り値を表示用に変換
function showAvailability(row, av) {
  const map = {
    available: ['ok', '利用可能', 'モデルはダウンロード済みです。'],
    downloadable: ['warn', '未ダウンロード', '使えますが、初回にモデルのダウンロードが必要です。「テスト」で取得できます。'],
    downloading: ['warn', 'ダウンロード中', 'モデルをダウンロードしています。'],
    unavailable: ['err', '利用不可', AI_UNAVAILABLE],
  };
  const [s, l, d] = map[av] || ['warn', String(av), '想定外の応答です。'];
  row.set(s, l, d);
}

// 内蔵AIの「テスト」ボタン：create() → 試しに1回使う → 必ず破棄する
function addAiTest(row, what, create, use) {
  row.addButton('テスト（必要ならダウンロード）', async () => {
    const dog = watchdog(90);
    let session, abandoned = false;
    const ctrl = new AbortController();
    try {
      const t0 = performance.now();
      // create() はボタン操作の直後に呼ぶ必要がある（await より前に呼んでいる）
      const creating = create(m => m.addEventListener('downloadprogress', e => {
        if (abandoned) return; // 打ち切ったあとは表示を上書きしない
        dog.kick();
        row.set('warn', `ダウンロード中 ${Math.round(e.loaded * 100)}%`, `${what}のモデルを取得しています。初回は数分かかることがあります。`);
      }), ctrl.signal);
      // 打ち切ったあとで create() が遅れて終わった場合も、作られたものは破棄する
      creating.then(s => { if (abandoned) try { s?.destroy?.(); } catch {} }, () => {});
      session = await dog.race(creating);
      const t1 = performance.now();
      dog.kick();
      const out = await dog.race(use(session));
      row.set('ok', '動作OK', `${String(out).trim()}（準備 ${since(t0, t1)}・処理 ${since(t1)}）`);
    } catch (e) {
      abandoned = true;
      ctrl.abort(); // 裏で続いているダウンロードも止める
      row.set('err', 'テスト失敗', e.message);
    } finally {
      dog.stop();
      try { session?.destroy?.(); } catch {}
    }
  });
}

// availability() を時間切れ付きで調べ、使える見込みがあればテストボタンを付ける
async function checkAiApi(row, availability, what, create, use) {
  let av;
  try { av = await withTimeout(availability()); showAvailability(row, av); }
  catch (e) { row.set('warn', '応答なし', e.message + '。「テスト」を押すと動くことがあります。'); }
  if (av !== 'unavailable') addAiTest(row, what, create, use);
}

// ---------- 1. 環境 ----------
async function checkEnv() {
  const g = makeGroup('ブラウザとPC');
  const rBrowser = g.add('ブラウザ');
  try {
    const uad = navigator.userAgentData;
    if (uad?.getHighEntropyValues) {
      const v = await withTimeout(uad.getHighEntropyValues(['fullVersionList', 'platformVersion']), 5);
      const all = v.fullVersionList || [];
      // ブランド一覧にはダミー（"Not:A-Brand" など）が混ざるので除く
      const main = all.find(b => !/not.?a.?brand|chromium/i.test(b.brand));
      const chromium = all.find(b => b.brand === 'Chromium');
      const label = main ? `${main.brand} ${main.version}` : chromium ? `Chromium系 ${chromium.version}` : '不明';
      let os = `${uad.platform} ${v.platformVersion || ''}`.trim();
      // Windowsは platformVersion の先頭が13以上なら Windows 11
      if (uad.platform === 'Windows') os = parseInt(v.platformVersion, 10) >= 13 ? 'Windows 11' : 'Windows 10';
      rBrowser.set('info', label, `OS: ${os}${main && chromium ? ` ／ Chromium ${chromium.version}` : ''}`);
    } else {
      rBrowser.set('warn', '不明', navigator.userAgent);
    }
  } catch (e) { rBrowser.set('warn', '取得失敗', navigator.userAgent); }

  const rPc = g.add('PCの性能（ブラウザから見える範囲）');
  const mem = navigator.deviceMemory;
  rPc.set('info', `CPU ${navigator.hardwareConcurrency || '?'}コア`,
    `メモリ: ${mem ? (mem >= 8 ? '8GB以上' : mem + 'GB') : '不明'}（ブラウザは最大8GBまでしか報告しません）`);

  const rOpen = g.add('ページの開き方');
  if (location.protocol === 'file:') rOpen.set('warn', 'ファイルを直接開いている', '音声認識や内蔵AIの結果が、https のURLで開いたときと違うことがあります。参考値として見てください。');
  else if (window.isSecureContext) rOpen.set('ok', '安全な接続（https など）');
  else rOpen.set('err', '安全でない接続（http）', 'https で開かないと、マイクや内蔵AIが使えません。');
}

// ---------- 2. 音声 ----------
async function checkSpeech() {
  const g = makeGroup('音声の取り込みと認識');
  const rSr = g.add('音声認識（Web Speech API）');
  if (!SR) rSr.set('err', 'このブラウザにない', '音声認識が使えません。ChromeかEdgeで開いてください。');
  else rSr.set('ok', 'あり', '実際に使えるかは、下の「音声認識を実際に試す」で確認してください（Edgeは network エラーが出ることがあります）。');

  const rLocal = g.add('端末内での音声認識');
  if (SR && typeof SR.available === 'function') {
    try {
      const av = await withTimeout(SR.available({ langs: ['en-US'], processLocally: true }));
      const map = {
        available: ['ok', '利用可能', '通信なしで音声認識できます。'],
        downloadable: ['info', '未ダウンロード', '端末内の認識モデルは未取得です（このアプリは通常のクラウド認識を使うので問題ありません）。'],
        downloading: ['info', 'ダウンロード中', ''],
        unavailable: ['info', '利用不可', '端末内での認識はできません（通常のクラウド認識は使えます）。'],
      };
      rLocal.set(...(map[av] || ['info', String(av), '']));
    } catch (e) { rLocal.set('info', '確認できず', e.message); }
  } else rLocal.set('info', '確認できず', 'このブラウザには確認用の機能がありません。通常のクラウド認識を使います。');

  const rDisp = g.add('画面・タブの音声の共有（getDisplayMedia）');
  if (navigator.mediaDevices?.getDisplayMedia) rDisp.set('ok', 'あり', '音声を認識に直接渡せるかは、下の「画面・タブの音声で試す」で確認してください。');
  else rDisp.set('err', 'なし', 'マイク方式を使ってください。');
}

// ---------- 3. 内蔵AI ----------
const LM_OPTS = { expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }], expectedOutputs: [{ type: 'text', languages: ['ja'] }] };
const SUM_OPTS = { type: 'key-points', format: 'plain-text', length: 'short', expectedInputLanguages: ['ja'], outputLanguage: 'ja' };

async function checkTranslator(g) {
  const r = g.add('翻訳（Translator API、英→日）');
  if (!('Translator' in self)) { r.set('err', 'このブラウザにない', '訳さずに英語だけを表示することになります。'); return; }
  const opts = { sourceLanguage: 'en', targetLanguage: 'ja' };
  await checkAiApi(r, () => Translator.availability(opts), '翻訳',
    (monitor, signal) => Translator.create({ ...opts, monitor, signal }),
    async t => '訳: ' + await t.translate('The primary endpoint was met, and the safety profile was consistent with previous studies.'));
}

async function checkPrompt(g) {
  const r = g.add('仕上げ訳・単語解説（Prompt API）');
  if (!('LanguageModel' in self)) { r.set('err', 'このブラウザにない', '仕上げ訳は使えず、翻訳APIの訳をそのまま表示します。'); return; }
  await checkAiApi(r, () => LanguageModel.availability(LM_OPTS), '内蔵LLM',
    (monitor, signal) => LanguageModel.create({ ...LM_OPTS, monitor, signal }),
    async s => '訳: ' + await s.prompt('次の英語を、直訳ではなく意味が伝わる簡潔な日本語に訳してください。訳文だけを出力してください。\n\nWe hit our primary endpoint, and frankly the safety data looked a lot cleaner than we expected.'));
}

async function checkSummarizer(g) {
  const r = g.add('要約（Summarizer API）');
  if (!('Summarizer' in self)) { r.set('err', 'このブラウザにない', 'Prompt APIが使えればそちらで要約します。'); return; }
  await checkAiApi(r, () => Summarizer.availability(SUM_OPTS), '要約',
    (monitor, signal) => Summarizer.create({ ...SUM_OPTS, monitor, signal }),
    async s => '要約: ' + await s.summarize('第3相試験で主要評価項目を達成しました。安全性はこれまでの試験と同様で、新たな懸念は見つかっていません。来年前半に米国で承認申請を行う予定です。日本では来年後半にPMDAと事前相談を行います。'));
}

async function checkAI() {
  const g = makeGroup('ブラウザ内蔵のAI（無料・PCの中で処理）');
  await Promise.all([checkTranslator(g), checkPrompt(g), checkSummarizer(g)]);
  const labels = g.rows.map(r => r.label);
  const r = g.add('管理者による制限');
  if (labels.includes('利用不可')) r.set('warn', '要確認', '「利用不可」があります。原因の一つとして、会社の管理者がポリシー（GenAILocalFoundationalModelSettings）で内蔵AIを止めている可能性があります。下の手順でポリシーを確認してください。');
  else if (labels.some(l => l === 'このブラウザにない' || l === '応答なし')) r.set('info', '一部未確認', '「利用不可」はありませんが、確認できなかった機能があります。「テスト」ボタンで確かめてください。');
  else r.set('ok', '制限は見当たらない', '');
}

// ---------- 4. 保存 ----------
async function checkStorage() {
  const g = makeGroup('記録の保存（このブラウザの中）');
  const rIdb = g.add('自動保存（IndexedDB）');
  try {
    await withTimeout(new Promise((ok, ng) => {
      const req = indexedDB.open('lt-check-temp');
      req.onsuccess = () => { req.result.close(); indexedDB.deleteDatabase('lt-check-temp'); ok(); };
      req.onerror = () => ng(req.error);
      req.onblocked = () => ng(new Error('ほかのタブが使用中です'));
    }), 10);
    rIdb.set('ok', '利用可能');
  } catch (e) { rIdb.set('err', '利用不可', `${e?.message || e}。自動保存ができません（プライベートウィンドウでは使えないことがあります）。`); }

  const rLs = g.add('設定の保存（localStorage）');
  try { localStorage.setItem('lt-check', '1'); localStorage.removeItem('lt-check'); rLs.set('ok', '利用可能'); }
  catch (e) { rLs.set('err', '利用不可', e.message); }

  const rQ = g.add('保存できる容量の目安');
  try {
    const { quota, usage } = await withTimeout(navigator.storage.estimate(), 5);
    if (quota) rQ.set('info', `約${(quota / 1024 ** 3).toFixed(1)}GB`, usage != null ? `使用中: ${(usage / 1024 ** 2).toFixed(1)}MB` : '');
    else rQ.set('info', '不明');
  } catch (e) { rQ.set('info', '不明'); }
}

// ---------- 音声認識の実地テスト ----------
const SR_ERRORS = {
  network: '通信エラー。Edgeでよく起きます。Chromeで試してください。',
  'not-allowed': 'マイク（または音声）の利用が許可されていません。アドレスバー左のアイコンから許可してください。',
  'audio-capture': 'マイクが見つかりません。',
  'no-speech': '音声が聞こえませんでした。音量を確認してください。',
  'language-not-supported': '英語の認識に対応していません。',
  'service-not-allowed': '音声認識サービスの利用が許可されていません（管理者による制限の可能性）。',
  // 以下はこの画面独自の名前（Web Speech API の正式なエラー名ではない）
  'start-with-track-unsupported': 'このブラウザは画面・タブの音声を認識に直接渡せません。マイク方式を使ってください。',
};

function runSpeechTest(kind, track) {
  const live = $('speechLive');
  return new Promise(resolve => {
    let finals = '', interim = '', done = false;
    const errors = [];
    const finish = () => {
      if (done) return; done = true;
      const heard = (finals + interim).trim();
      let msg = errors.length
        ? `エラー: ${errors.map(e => `${e}（${SR_ERRORS[e] || '詳細不明'}）`).join(' ／ ')}`
        : heard ? '正常に認識できました。' : '何も聞き取れませんでした。英語の音声が流れていたか確認してください。';
      // 古いブラウザは start(音声) の引数を黙って無視し、マイクで聞き取ってしまう
      if (track && heard && !errors.length) msg += '（注: マイクに音が入らない状態で試した場合だけ、画面・タブ音声を直接取り込めたと判断できます）';
      live.textContent = `【${kind}】${msg}\n聞き取った英語: ${heard || '（なし）'}`;
      extraResults.push(`${new Date().toLocaleTimeString('ja-JP')} 音声認識テスト（${kind}）:${msg} ／ 聞き取り: ${heard.slice(0, 120) || 'なし'}`);
      resolve();
    };
    const r = new SR();
    r.lang = 'en-US'; r.continuous = true; r.interimResults = true;
    r.onresult = ev => {
      interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finals += res[0].transcript + ' '; else interim += res[0].transcript;
      }
      live.textContent = `【${kind}】認識中…\n${finals}${interim}`;
    };
    r.onerror = e => { if (e.error !== 'aborted') errors.push(e.error); };
    r.onend = finish;
    try {
      if (track) r.start(track); else r.start();
      live.textContent = `【${kind}】10秒間聞き取ります…`;
    } catch (e) {
      errors.push(track ? 'start-with-track-unsupported' : `start-failed: ${e.message}`);
      finish(); return;
    }
    setTimeout(() => { try { r.stop(); } catch {} }, 10000);
    // onend が来ない場合の保険：認識を確実に止めてから結果を出す
    setTimeout(() => { try { r.abort(); } catch {} finish(); }, 13000);
  });
}

function setSpeechButtons(disabled) { $('testMic').disabled = $('testDisplay').disabled = disabled; }

$('testMic').onclick = async () => {
  if (!SR) { toast('このブラウザは音声認識に対応していません'); return; }
  setSpeechButtons(true);
  try { await runSpeechTest('マイク'); } finally { setSpeechButtons(false); }
};

$('testDisplay').onclick = async () => {
  if (!SR) { toast('このブラウザは音声認識に対応していません'); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) { toast('このブラウザは画面・タブの共有に対応していません。マイクで試してください。', 5000); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
  catch (e) {
    // NotAllowedError はキャンセルのほか、管理者や OS による禁止でも返る
    const msg = e.name === 'NotAllowedError'
      ? `画面共有がキャンセルされたか、許可されていません（${e.message}）`
      : `画面共有を開始できませんでした（${e.name}: ${e.message}）`;
    $('speechLive').textContent = `【画面・タブ音声】${msg}`;
    extraResults.push(`${new Date().toLocaleTimeString('ja-JP')} 音声認識テスト（画面・タブ音声）: ${msg}`);
    toast(msg, 5000);
    return;
  }
  stream.getVideoTracks().forEach(t => t.stop()); // 映像は使わない（保存・送信もしない）
  const track = stream.getAudioTracks()[0];
  if (!track) {
    $('speechLive').textContent = '【画面・タブ音声】音声が共有されていません。共有の画面で「タブの音声も共有する」（画面全体なら「システムの音声も共有する」）をオンにしてください。';
    extraResults.push('音声認識テスト（画面・タブ音声）: 音声トラックなし（共有時に音声がオフ）');
    return;
  }
  setSpeechButtons(true);
  try { await runSpeechTest('画面・タブ音声', track); }
  finally { stream.getTracks().forEach(t => t.stop()); setSpeechButtons(false); }
};

// ---------- 結果のコピー ----------
function reportText() {
  // file:// で開いたときはパスにWindowsのユーザー名が入るので、URLは書かない
  const where = location.protocol === 'file:' ? 'ファイルを直接開いた' : `${location.origin}${location.pathname}`;
  const lines = [`ライブ翻訳ノート 動作確認結果（${new Date().toLocaleString('ja-JP')}）`, `開き方: ${where}`];
  for (const g of groups) {
    lines.push('', `■ ${g.title}`);
    for (const r of g.rows) lines.push(`${STATE_LABEL[r.state]} ${r.name}: ${r.label}${r.detail ? ' ／ ' + r.detail : ''}`);
  }
  if (extraResults.length) lines.push('', '■ 実地テスト', ...extraResults);
  return lines.join('\n');
}

function showManualCopy(text) {
  const box = $('copyFallback');
  box.hidden = false;
  box.value = text;
  box.focus(); box.select();
  toast('自動でコピーできませんでした。表示された文章を選択してコピーしてください。', 6000);
}

$('copy').onclick = async () => {
  const text = reportText();
  try { await navigator.clipboard.writeText(text); toast('結果をコピーしました。チャットなどに貼り付けてください。'); return; }
  catch {}
  const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  if (ok) toast('結果をコピーしました。'); else showManualCopy(text);
};

// ---------- 実行 ----------
let checking = false;
async function runAll() {
  if (checking) return; // 確認中に押されても二重に走らせない
  checking = true;
  $('recheck').disabled = $('copy').disabled = true;
  try {
    groups.length = 0; $('groups').innerHTML = '';
    $('copyFallback').hidden = true;
    await checkEnv();
    await checkSpeech();
    await checkAI();
    await checkStorage();
  } finally {
    checking = false;
    $('recheck').disabled = $('copy').disabled = false;
  }
}
$('recheck').onclick = runAll;
runAll();
