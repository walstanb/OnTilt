// Minimal DOM patcher: updates `root` to match `html`, reusing existing nodes where the
// tag (and optional data-k key) match. Reused nodes keep running CSS transitions; new
// nodes get their entry animations. Inputs keep their live value while focused.

// Elements must also agree on id: nodes with an id usually carry JS handlers (the stakes ruler,
// your cards, the raise slider), and reusing one for a different element would keep those handlers.
const sameNode = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName &&
  (a.nodeType !== 1 || ((a.getAttribute('data-k') ?? '') === (b.getAttribute('data-k') ?? '') &&
                        (a.id || '') === (b.id || '')));

function patchAttrs(a, b){
  for(const { name } of [...a.attributes]) if(!b.hasAttribute(name)) a.removeAttribute(name);
  for(const { name, value } of [...b.attributes]) if(a.getAttribute(name) !== value) a.setAttribute(name, value);
}

function patchChildren(a, b){
  const from = [...a.childNodes], to = [...b.childNodes];
  to.forEach((y, i) => {
    const x = from[i];
    if(!x){ a.appendChild(y); return; }
    if(!sameNode(x, y)){ a.replaceChild(y, x); return; }
    if(x.nodeType !== 1){ if(x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; return; }
    patchAttrs(x, y);
    if(x.nodeName === 'INPUT'){
      const v = y.getAttribute('value') ?? '';
      if(document.activeElement !== x && x.value !== v) x.value = v;
      return;
    }
    patchChildren(x, y);
  });
  for(let i = from.length - 1; i >= to.length; i--) from[i].remove();
}

export function morph(root, html){
  const t = document.createElement('template');
  t.innerHTML = html;
  patchChildren(root, t.content);
}
