// 段落データの保持と翻訳段階の管理（純粋モジュール）
// Paragraph = {id, startedAt, sentences[], fillers[], src, srcForTranslate, ja,
//              stage:'pending'|'paragraph'|'refined'|'filler', closed, version}
// - fillers[i] は sentences[i] があいづちだけの文かどうか
// - src は全文（表示用）、srcForTranslate はあいづちでない文だけを ' ' で連結したもの（翻訳用）
// 外に返すのはコピー。返した値を書き換えても中身は変わらない。

const STAGES = new Set(['paragraph', 'refined']);

function copy(p) {
  return { ...p, sentences: p.sentences.slice(), fillers: p.fillers.slice() };
}

export function createTranscript() {
  const byId = new Map();   // paraId -> Paragraph
  const order = [];         // 段落の並び（paraId）
  const jaVersion = new Map(); // paraId -> 反映済みの段落訳の version

  return {
    // 段落を作る。すでにあれば何もしない。作った（または既存の）段落のコピーを返す
    openParagraph(paraId, startedAt) {
      let p = byId.get(paraId);
      if (!p) {
        p = { id: paraId, startedAt, sentences: [], fillers: [], src: '', srcForTranslate: '', ja: '', stage: 'pending', closed: false, version: 0 };
        byId.set(paraId, p);
        order.push(paraId);
      }
      return copy(p);
    },

    // 文を足して version を1増やす。新しい version を返す。段落がない・閉じているときは null
    // filler: true の文（あいづちだけ）は表示用の src には入るが、翻訳用の srcForTranslate には入らず、
    // version も上げない（訳す中身が変わらないので、段落訳の版を進めない）。戻り値は今の version
    addSentence(paraId, text, opts) {
      const filler = !!(opts && opts.filler); // 形は { filler = false } = {}。null を渡されても落ちない
      const p = byId.get(paraId);
      if (!p || p.closed) return null;
      const t = String(text ?? '');
      // translateText: 訳に使う文（文頭・文末のあいづちを除いたものなど）。省略時は text と同じ
      const tt = opts && typeof opts.translateText === 'string' ? opts.translateText : t;
      p.sentences.push(t);
      p.fillers.push(filler);
      if (!p.translateTexts) Object.defineProperty(p, 'translateTexts', { value: [], writable: true, enumerable: false });
      p.translateTexts.push(tt);
      p.src = p.sentences.join(' ');
      if (!filler) {
        p.srcForTranslate = p.translateTexts.filter((x, i) => !p.fillers[i] && x).join(' ');
        p.version++;
      }
      return p.version;
    },

    // 段落を閉じる。成功なら true。
    // あいづちでない文が1つもなければ stage を 'filler' にする（訳さない段落。訳は空）
    close(paraId) {
      const p = byId.get(paraId);
      if (!p) return false;
      p.closed = true;
      if (!p.fillers.some((f) => !f)) {
        p.stage = 'filler';
        p.ja = '';
      }
      return true;
    },

    // 訳を入れる。反映したら true。
    // - refined のあとに来た paragraph は無視
    // - すでに反映した段落訳より古い version の paragraph は無視（順番が入れ替わって届いた場合）
    // - version を省略した paragraph は、その時点の段落の version として扱う
    // - 'filler' の段落（あいづちだけ）は訳を受け付けない
    setJa(paraId, ja, stage, version) {
      const p = byId.get(paraId);
      if (!p || !STAGES.has(stage)) return false;
      if (p.stage === 'filler') return false;
      if (typeof ja !== 'string' || ja.trim() === '') return false;
      if (stage === 'paragraph') {
        if (p.stage === 'refined') return false;
        const v = typeof version === 'number' ? version : p.version;
        const applied = jaVersion.get(paraId);
        if (applied !== undefined && v < applied) return false;
        jaVersion.set(paraId, v);
      }
      p.ja = ja;
      p.stage = stage;
      return true;
    },

    get(paraId) {
      const p = byId.get(paraId);
      return p ? copy(p) : null;
    },

    all() {
      return order.map((id) => copy(byId.get(id)));
    },

    // 直近 n 段落（古い順）。beforeParaId を渡すと、その段落より前だけ。見つからない id なら []
    recent(n, beforeParaId) {
      if (!(n > 0)) return [];
      let end = order.length;
      if (beforeParaId !== undefined && beforeParaId !== null) {
        end = order.indexOf(beforeParaId);
        if (end < 0) return [];
      }
      return order.slice(Math.max(0, end - n), end).map((id) => copy(byId.get(id)));
    },

    // いちばん良い訳（仕上げ訳があればそれ、なければ段落訳）。なければ ''。'filler' の段落は ''
    bestJa(paraId) {
      const p = byId.get(paraId);
      return p ? p.ja : '';
    },

    clear() {
      byId.clear();
      order.length = 0;
      jaVersion.clear();
    },
  };
}
