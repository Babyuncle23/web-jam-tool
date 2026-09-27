/**
 * Marks a scroller when more content sits past the visible edge.
 * One measurement after layout, then updates on scroll and resize.
 */

export function markScrollEdges(el, axis = 'x') {
  if (!el) return;
  el.dataset.edgeAxis = axis;
  const update = () => {
    const mode = el.dataset.edgeAxis || 'x';
    const maxX = el.scrollWidth - el.clientWidth;
    const maxY = el.scrollHeight - el.clientHeight;
    const horizontal = mode !== 'y';
    const vertical = mode !== 'x';
    el.classList.toggle('edge-left', horizontal && el.scrollLeft > 2);
    el.classList.toggle('edge-right', horizontal && maxX - el.scrollLeft > 2);
    el.classList.toggle('edge-top', vertical && el.scrollTop > 2);
    el.classList.toggle('edge-bottom', vertical && maxY - el.scrollTop > 2);
  };
  if (el.dataset.edges !== '1') {
    el.dataset.edges = '1';
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
  }
  update();
}

export function markPageEdges() {
  const update = () => {
    const root = document.scrollingElement || document.documentElement;
    const maxY = root.scrollHeight - window.innerHeight;
    const pageScrolls = getComputedStyle(document.body).overflowY !== 'hidden';
    document.body.classList.toggle('page-edge-top', pageScrolls && window.scrollY > 2);
    document.body.classList.toggle('page-edge-bottom', pageScrolls && maxY - window.scrollY > 2);
  };
  if (!document.body.dataset.pageEdges) {
    document.body.dataset.pageEdges = '1';
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
  }
  update();
}
