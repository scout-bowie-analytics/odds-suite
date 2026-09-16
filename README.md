# 🐾 Scout Bowie NFL Odds Suite

100% client-side NFL quantitative analytics platform powered by Scout Bowie. Built with Vanilla JS, HTML5, CSS3, and Web Workers with zero external backends or API keys.

---

## ⚡ Core Modules

### 1. 🏈 Survivor & Pick'em Optimizer
* **Dynamic Lookahead Pathfinder**: Computes the mathematically optimal 18-week path across mid-size and mega survivor pools.
* **10,000-Game Monte Carlo Pool Simulator**: Simulates opponent survivor attrition and pool equity off the main UI thread.
* **Confidence Point Ranker**: Ranks weekly matchups 16 to 1 based on Vegas win probability and public pick leverage.

### 2. ⚡ Parlay & Same-Game Parlay (SGP) Engine
* **Correlated SGP Score Generator**: Evaluates intra-game legs against synchronized simulated scorelines via Box-Muller normal sampling ($sigma = 10.5$).
* **Vig-Free Correlation Boost Math**:
  $$\text{Correlation Boost} = \left(P_{\text{sim}} - \prod_{i=1}^n P_{\text{fair\_indep}, i}\right) \times 100$$
* **Expected Value (+EV) & Vig Analytics**: Computes true win probability, fair American odds, and bookmaker edge.
* **Bet Slip Dock**: Dynamic ticket classification, interactive market pills (Spread, Total, ML), and conflict auto-replacement.

---

## 🚀 Live Demo
Hosted on GitHub Pages: [https://scout-bowie-analytics.github.io/odds-suite/](https://scout-bowie-analytics.github.io/odds-suite/)
