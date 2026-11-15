// 本体の処理（試作版から移植。第1段階で区切り・3段階翻訳に作り替える）
const $ = id => document.getElementById(id);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let running = false, rec = null, audioTrack = null, displayStream = null;
let translator = null, summarizer = null, trKey = '';
let segs = [];            // {time, src, ja}
let lastSumIdx = 0, sumTimer = null, startAt = 0, clockTimer = null;
let trChain = Promise.resolve();

function toast(t, ms=4000){const m=$('msg');m.textContent=t;m.style.display='block';clearTimeout(m._t);m._t=setTimeout(()=>m.style.display='none',ms)}
function setStat(dot, el, cls, text){$(dot).className='dot '+cls;$(el).textContent=text}
function langs(){const [rec, tr] = $('srcLang').value.split('|');return {rec, tr}}
function hhmm(d){return d.toTimeString().slice(0,5)}

// ---------- 翻訳（ブラウザ内蔵AI・無料・端末内処理） ----------
async function ensureTranslator(userClick){
  const {tr} = langs();
  if (!('Translator' in self)){setStat('dTr','sTr','err','このブラウザ非対応（原文のみ表示）');return null}
  if (translator && trKey===tr) return translator;
  try{
    const av = await Translator.availability({sourceLanguage:tr,targetLanguage:'ja'});
    if (av==='unavailable'){setStat('dTr','sTr','err','この言語の組み合わせは非対応');return null}
    if (av!=='available' && !userClick){setStat('dTr','sTr','warn','「準備」ボタンを押してください');return null}
    setStat('dTr','sTr','warn','モデル準備中…');
    translator = await Translator.create({sourceLanguage:tr,targetLanguage:'ja',
      monitor(m){m.addEventListener('downloadprogress',e=>setStat('dTr','sTr','warn',`ダウンロード中 ${Math.round(e.loaded*100)}%`))}});
    trKey = tr; setStat('dTr','sTr','ok','利用可能（端末内）');
    return translator;
  }catch(e){setStat('dTr','sTr','err','準備失敗: '+e.message);return null}
}
async function ensureSummarizer(userClick){
  if (!('Summarizer' in self)){setStat('dSum','sSum','err','このブラウザ非対応');return null}
  if (summarizer) return summarizer;
  const opts={type:'key-points',format:'plain-text',length:'medium',expectedInputLanguages:['ja'],outputLanguage:'ja'};
  try{
    const av = await Summarizer.availability(opts);
    if (av==='unavailable'){setStat('dSum','sSum','err','このPCでは利用不可（性能要件）');return null}
    if (av!=='available' && !userClick){setStat('dSum','sSum','warn','「準備」ボタンを押してください');return null}
    setStat('dSum','sSum','warn','モデル準備中…');
    summarizer = await Summarizer.create({...opts,
      monitor(m){m.addEventListener('downloadprogress',e=>setStat('dSum','sSum','warn',`ダウンロード中 ${Math.round(e.loaded*100)}%`))}});
    setStat('dSum','sSum','ok','利用可能（端末内）');
    return summarizer;
  }catch(e){setStat('dSum','sSum','err','準備失敗: '+e.message);return null}
}
$('prep').onclick = async ()=>{ await ensureTranslator(true); if ($('sumEvery').value!=='0') await ensureSummarizer(true); };

// ---------- 表示 ----------
function addSeg(src){
  const list=$('list'); if (list.querySelector('.empty')) list.innerHTML='';
  const seg={time:new Date(),src,ja:''}; segs.push(seg);
  const div=document.createElement('div'); div.className='seg';
  div.innerHTML=`<div class="ja"><span class="t">${hhmm(seg.time)}</span><span class="jt">…</span></div><div class="src"></div>`;
  div.querySelector('.src').textContent=src; list.appendChild(div);
  const nearBottom = $('log').scrollHeight-$('log').scrollTop-$('log').clientHeight < 200;
  // 翻訳は順番通りに実行（訳が前後しないように）
  trChain = trChain.then(async ()=>{
    const t = translator;
    if (!t){ div.querySelector('.jt').textContent=src; seg.ja=''; return; }
    try{ seg.ja = await t.translate(src); div.querySelector('.jt').textContent=seg.ja; }
    catch(e){ div.querySelector('.jt').textContent=src; }
    if (nearBottom) $('log').scrollTop=$('log').scrollHeight;
  });
  if (nearBottom) $('log').scrollTop=$('log').scrollHeight;
}

// ---------- 音声認識 ----------
function newRecognition(){
  const r = new SR(); r.lang = langs().rec; r.continuous = true; r.interimResults = true;
  r.onresult = ev=>{
    let interim='';
    for (let i=ev.resultIndex;i<ev.results.length;i++){
      const res=ev.results[i], txt=res[0].transcript.trim();
      if (res.isFinal){ if (txt) addSeg(txt); } else interim += txt+' ';
    }
    $('interim').textContent = interim;
  };
  r.onerror = e=>{
    if (e.error==='no-speech'||e.error==='aborted') return;
    setStat('dRec','sRec','err','エラー: '+e.error);
    if (e.error==='not-allowed') { toast('マイク／音声の利用が許可されていません'); stop(); }
  };
  r.onend = ()=>{ if (running) setTimeout(startRecognition, 250); }; // 無音で止まっても自動再開
  return r;
}
function startRecognition(){
  if (!running) return;
  rec = newRecognition();
  try{
    if (audioTrack) rec.start(audioTrack); else rec.start();
    setStat('dRec','sRec','ok', audioTrack ? '取り込み中（画面・タブ音声）' : '取り込み中（マイク）');
  }catch(e){
    if (audioTrack){ setStat('dRec','sRec','err','このブラウザは画面音声の直接取り込みに未対応。マイクを使ってください'); stop(); }
    else setStat('dRec','sRec','err','開始失敗: '+e.message);
  }
}

async function start(){
  if (!SR){ toast('このブラウザは音声認識に対応していません（Chrome／Edgeを使ってください）'); return; }
  audioTrack=null;
  if ($('source').value==='display'){
    try{
      displayStream = await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
      const at = displayStream.getAudioTracks()[0];
      if (!at){ toast('音声が取得できませんでした。共有時に「音声も共有する」をオンにしてください',7000); displayStream.getTracks().forEach(t=>t.stop()); return; }
      displayStream.getVideoTracks().forEach(t=>t.stop()); // 映像は不要
      audioTrack = at; at.onended = ()=>stop();
    }catch(e){ toast('画面共有がキャンセルされました'); return; }
  }
  await ensureTranslator(false);
  running=true; $('start').disabled=true; $('stop').disabled=false;
  startAt=Date.now(); clockTimer=setInterval(()=>{const s=Math.floor((Date.now()-startAt)/1000);$('elapsed').textContent=`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`},1000);
  const n=+$('sumEvery').value; if (n>0){ await ensureSummarizer(false); sumTimer=setInterval(doSummary, n*60*1000); }
  startRecognition();
}
function stop(){
  running=false; try{rec&&rec.stop()}catch(e){}
  if (displayStream){displayStream.getTracks().forEach(t=>t.stop());displayStream=null}
  audioTrack=null; clearInterval(sumTimer); clearInterval(clockTimer);
  $('start').disabled=false; $('stop').disabled=true; $('interim').textContent='';
  setStat('dRec','sRec','','停止');
}
$('start').onclick=start; $('stop').onclick=stop;

// ---------- 要約 ----------
async function doSummary(manual){
  const part = segs.slice(lastSumIdx); if (!part.length){ if(manual) toast('要約する内容がまだありません'); return; }
  const s = await ensureSummarizer(!!manual); if (!s){ if(manual) toast('要約機能がこのPCでは使えません'); return; }
  const text = part.map(x=>x.ja||x.src).join('\n'); if (text.length<80 && !manual) return;
  const from=hhmm(part[0].time), to=hhmm(part[part.length-1].time); lastSumIdx=segs.length;
  const sums=$('sums'); if (sums.querySelector('.empty')) sums.innerHTML='';
  const card=document.createElement('div'); card.className='sum'; card.innerHTML=`<div class="h">${from}〜${to} の要約</div><div class="b">要約中…</div>`;
  sums.prepend(card);
  try{ card.querySelector('.b').textContent = await s.summarize(text.slice(-12000),{context:'海外の講演・ウェビナーの文字起こし（機械翻訳）です。要点を日本語で簡潔に。'}); }
  catch(e){ card.querySelector('.b').textContent='要約に失敗しました: '+e.message; }
}
$('sumNow').onclick=()=>doSummary(true);

// ---------- その他 ----------
let fs=22; const setFs=()=>document.documentElement.style.setProperty('--fs',fs+'px');
$('fsUp').onclick=()=>{fs=Math.min(40,fs+2);setFs()}; $('fsDown').onclick=()=>{fs=Math.max(14,fs-2);setFs()};
$('toggleSrc').onclick=()=>{const h=$('log').classList.toggle('hide-src');$('toggleSrc').textContent=h?'原文を表示':'原文を隠す'};
$('clear').onclick=()=>{segs=[];lastSumIdx=0;$('list').innerHTML='';$('sums').innerHTML='<div class="empty">要約はここに表示されます。</div>'};
$('save').onclick=()=>{
  const body = segs.map(s=>`[${hhmm(s.time)}] ${s.ja||s.src}\n        (${s.src})`).join('\n')
    + '\n\n==== 要約 ====\n' + [...document.querySelectorAll('.sum')].reverse().map(c=>c.innerText).join('\n\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([body],{type:'text/plain'}));
  a.download=`翻訳ノート_${new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')}.txt`; a.click();
};
$('srcLang').onchange=()=>{translator=null; ensureTranslator(false)};
// 起動時に対応状況を確認
ensureTranslator(false); ensureSummarizer(false);
if (!SR) setStat('dRec','sRec','err','このブラウザは非対応');
