// 訳の表示（段落の描画、速報行、仕上げ訳の色付け、自動スクロールと「最新へ戻る」）
// 画面に文字を入れるときは必ず textContent を使う（認識結果・訳文を innerHTML に入れない）。
// 閉じた段落の要素は作り直さず、中身の文字と data-stage だけを書き換える。
// 2時間で数百段落になるため、書き換えは requestAnimationFrame で1フレームにまとめる。

const FOLLOW_MARGIN_PX = 80;      // 下から何pxまでなら「最新を追っている」とみなすか
const FLASH_FALLBACK_MS = 2000;   // animationend が来ないとき（アニメ無効など）に色付けを外すまでの時間

function pad2(n){ return String(n).padStart(2, '0'); }
function hhmm(t){
  const d = t instanceof Date ? t : new Date(typeof t === 'number' ? t : Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function setText(el, text){ if (el.textContent !== text) el.textContent = text; }

export function createView({ listEl, flashEl, logEl, backBtn }){
  const nodes = new Map();        // paraId -> { root, jt, src }
  const dirty = new Map();        // paraId -> 最新の段落データ（参照）
  const flashQueue = new Set();   // 描画後に色付けする paraId
  let flashText = null;           // 次のフレームで速報行に入れる文字（null は変更なし）
  let flashVisible = true;
  let follow = true;
  let wantScroll = false;
  let rafId = 0;
  let programmaticTop = -1;       // 自分でスクロールさせた位置（その scroll イベントは無視する）

  function schedule(){
    if (rafId) return;
    rafId = requestAnimationFrame(flush);
  }

  // ---------- 段落 ----------
  function build(p){
    const root = document.createElement('div');
    root.className = 'para';
    root.dataset.id = p.id;
    root.dataset.stage = p.stage || 'pending';
    const ja = document.createElement('div'); ja.className = 'ja';
    const t = document.createElement('span'); t.className = 't'; t.textContent = hhmm(p.startedAt);
    const jt = document.createElement('span'); jt.className = 'jt'; jt.textContent = p.ja || '…';
    const src = document.createElement('div'); src.className = 'src'; src.textContent = p.src || '';
    ja.append(t, jt); root.append(ja, src);
    return { root, jt, src };
  }

  function ensureParagraph(p){
    if (!p || !p.id) return null;
    let n = nodes.get(p.id);
    if (n) return n.root;
    // 最初の段落を作るときに「使い方」の表示を消す
    const empty = listEl.querySelector(':scope > .empty');
    if (empty) empty.remove();
    n = build(p);
    nodes.set(p.id, n);
    listEl.appendChild(n.root);
    wantScroll = true;
    schedule();
    return n.root;
  }

  function updateParagraph(p){
    if (!p || !p.id) return;
    if (!nodes.has(p.id)) ensureParagraph(p);
    dirty.set(p.id, p);
    schedule();
  }

  function apply(p){
    const n = nodes.get(p.id);
    if (!n) return;
    setText(n.jt, p.ja ? p.ja : '…');
    setText(n.src, p.src || '');
    const stage = p.stage || 'pending';
    if (n.root.dataset.stage !== stage) n.root.dataset.stage = stage;
  }

  function markRefined(paraId){
    if (!nodes.has(paraId)) return;
    flashQueue.add(paraId);
    schedule();
  }

  function startFlash(root){
    if (root.classList.contains('refined-flash')){
      root.classList.remove('refined-flash');
      void root.offsetWidth; // アニメをやり直すために一度レイアウトを確定させる
    }
    clearTimeout(root._flashTimer);
    const done = () => {
      clearTimeout(root._flashTimer);
      root.classList.remove('refined-flash');
      root.removeEventListener('animationend', done);
    };
    root.addEventListener('animationend', done);
    root._flashTimer = setTimeout(done, FLASH_FALLBACK_MS);
    root.classList.add('refined-flash');
  }

  // ---------- 速報行 ----------
  function setFlash(text){
    flashText = flashVisible ? String(text ?? '') : '';
    schedule();
  }
  function setFlashVisible(on){
    flashVisible = !!on;
    if (flashEl) flashEl.hidden = !flashVisible;
    if (!flashVisible){ flashText = ''; schedule(); }
  }

  // ---------- 自動スクロール ----------
  function nearBottom(){
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= FOLLOW_MARGIN_PX;
  }
  function scrollToBottom(){
    logEl.scrollTop = logEl.scrollHeight;
    programmaticTop = logEl.scrollTop; // 値が丸められても実際の位置を覚える
  }
  function setFollow(on){
    follow = on;
    if (backBtn) backBtn.hidden = follow;
  }
  function onScroll(){
    // 自分で動かしたスクロールでは追従の状態を変えない
    if (programmaticTop >= 0 && Math.abs(logEl.scrollTop - programmaticTop) < 1){
      programmaticTop = -1;
      return;
    }
    programmaticTop = -1;
    const nb = nearBottom();
    if (nb !== follow) setFollow(nb);
  }
  function scrollIfFollowing(){
    wantScroll = true;
    schedule();
  }
  function scrollToLatest(){
    setFollow(true);
    wantScroll = true;
    schedule();
  }

  if (logEl) logEl.addEventListener('scroll', onScroll, { passive: true });
  if (backBtn){
    backBtn.hidden = true;
    backBtn.addEventListener('click', scrollToLatest);
  }

  // ---------- まとめて描画 ----------
  function flush(){
    rafId = 0;
    const changed = dirty.size > 0 || flashText !== null || wantScroll;
    for (const p of dirty.values()) apply(p);
    dirty.clear();
    for (const id of flashQueue){
      const n = nodes.get(id);
      if (n) startFlash(n.root);
    }
    flashQueue.clear();
    if (flashText !== null && flashEl){ setText(flashEl, flashText); }
    flashText = null;
    if (changed && follow && logEl) scrollToBottom();
    wantScroll = false;
  }

  function clear(){
    if (rafId){ cancelAnimationFrame(rafId); rafId = 0; }
    for (const n of nodes.values()) clearTimeout(n.root._flashTimer);
    nodes.clear(); dirty.clear(); flashQueue.clear();
    flashText = null; wantScroll = false;
    listEl.replaceChildren();
    if (flashEl) flashEl.textContent = '';
    setFollow(true);
  }

  return {
    ensureParagraph, updateParagraph, markRefined,
    setFlash, setFlashVisible,
    scrollIfFollowing, scrollToLatest,
    isFollowing: () => follow,
    clear,
  };
}
