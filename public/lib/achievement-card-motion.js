let observer;

/** 只在收藏卡真正进入视野时反光一次；手机滚动与减少动态偏好不受干扰。 */
export function mountAchievementCardMotion() {
  observer?.disconnect(); observer = null;
  if (typeof document === 'undefined' || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const cards = document.querySelectorAll('.achievement-card.tier-3, .achievement-card.tier-4');
  if (!cards.length) return;
  if (typeof IntersectionObserver !== 'function') return;
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-revealed'); observer?.unobserve(entry.target);
    }
  }, { threshold: .35 });
  cards.forEach(card => observer.observe(card));
}
