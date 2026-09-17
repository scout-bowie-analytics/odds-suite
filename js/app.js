/**
 * 🐾 SCOUT BOWIE NFL SURVIVOR & ODDS SUITE APPLICATION CONTROLLER
 * High-Performance Client-Side State Manager & View Router
 */

import { SurvivorEngine } from './survivorEngine.js';
import { ParlayEngine } from './parlayEngine.js';
import { OddsUtils, normalizeGame, createBetLeg } from './contracts.js';

class OddsSuiteApp {
  constructor() {
    this.engine = new SurvivorEngine();
    this.parlayEngine = new ParlayEngine();

    this.state = {
      slateData: [],
      slateMetadata: null,
      activeWeek: 1,
      poolSize: 100,
      strategy: 'contrarian', // 'survival' | 'contrarian'
      currentView: 'survivor', // 'survivor' | 'pickem' | 'parlay'
      pickemMode: 'straight_up', // 'straight_up' | 'ats'
      lockedPicks: {}, // { [week]: teamCode }
      excludedTeams: new Set(),
      currentPathResult: null,
      weeklySpotlight: null,
      pickemConfidence: null,
      simResults: null,
      isSimulating: false,
      // Parlay & SGP State
      parlayFilter: 'all', // 'all' | 'spread' | 'total' | 'moneyline'
      parlaySimResults: null,
      isParlaySimulating: false,
      // Auto-Ticket Generator State (v3.9.0 Multi-Ticket Batching)
      autoBuildLegs: 3,
      autoBuildStrategy: 'best_value', // 'high_win' | 'best_value'
      autoBuildTicketCount: 1, // 1 | 2 | 3
      generatedTickets: [], // [{ id, legs, combinedOdds, formattedOdds, simResults, analytics, classification }]
      activeTicketIndex: 0,
      autoBuildAccordionOpen: false,
      isAutoBuilding: false
    };

    this.worker = null;
    this.init();
  }

  /**
   * Dynamically calculate current NFL week anchored to 2026 season:
   * Week 2 begins Tuesday, September 15, 2026 at 06:00 UTC.
   * Every subsequent Tuesday at 06:00 UTC advances the week by 1.
   * Clamped strictly between Week 1 and Week 18.
   */
  getCurrentNFLWeek(now = Date.now()) {
    const W2_START = Date.UTC(2026, 8, 15, 6, 0, 0); // Tue Sep 15 2026 06:00 UTC
    const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
    const diffMs = (typeof now === 'number' ? now : new Date(now).getTime()) - W2_START;
    if (diffMs < 0) return 1;
    const week = 2 + Math.floor(diffMs / MS_PER_WEEK);
    return Math.max(1, Math.min(18, week));
  }

  async init() {
    this.bindGlobalHandlers();
    this.initWorker();

    // Auto-default to the active NFL week
    this.state.activeWeek = this.getCurrentNFLWeek();

    try {
      const res = await fetch('data/nfl_slate.json?v=' + Date.now());
      if (!res.ok) throw new Error('Failed to load NFL slate data');
      const rawData = await res.json();

      if (Array.isArray(rawData)) {
        this.state.slateData = rawData;
        this.state.slateMetadata = {
          lastSyncedAt: new Date().toISOString(),
          syncStatus: 'COMPLETE',
          totalGames: 272,
          syncedGames: 272
        };
      } else {
        this.state.slateData = rawData.weeks || [];
        this.state.slateMetadata = {
          lastSyncedAt: rawData.lastSyncedAt || new Date().toISOString(),
          syncStatus: rawData.syncStatus || 'COMPLETE',
          totalGames: rawData.totalGames || 272,
          syncedGames: rawData.syncedGames || 272
        };
      }

      // Sync week select dropdown to dynamically calculated active week
      const weekSelect = document.getElementById('weekSelect') || document.getElementById('activeWeekSelect');
      if (weekSelect) weekSelect.value = String(this.state.activeWeek);

      this.recalculateAll();
      this.renderAll();
      this.runMonteCarloSim();
    } catch (err) {
      console.error('Initialization error:', err);
      this.showToast('⚠️ Error loading NFL schedule slate.');
    }
  }

  initWorker() {
    try {
      // Use module worker with cache versioning for fast async simulation
      this.worker = new Worker('js/simulationWorker.js?v=3.9.0', { type: 'module' });
      this.worker.onmessage = (e) => {
        const { type, percent, results, error, generatedLegs, simResults } = e.data || {};
        
        // 1. Survivor Sim Events
        if (type === 'progress') {
          this.updateSimProgress(percent);
        } else if (type === 'complete') {
          this.state.simResults = results;
          this.state.isSimulating = false;
          this.renderSimulationResults();
        } else if (type === 'error') {
          console.error('Worker simulation error:', error);
          this.state.isSimulating = false;
          this.runSyncFallback();
        }

        // 2. Parlay Sim Events
        else if (type === 'parlay_progress') {
          const badge = document.getElementById('slipSimStatusBadge');
          if (badge) badge.textContent = `⚡ Simulating (${percent}%)...`;
        } else if (type === 'parlay_complete') {
          this.state.parlaySimResults = results;
          this.state.isParlaySimulating = false;
          this.renderBetSlip();
        } else if (type === 'parlay_error') {
          console.error('Worker parlay simulation error:', error);
          this.state.isParlaySimulating = false;
          this.runSyncParlayFallback();
        }

        // 3. Asynchronous Auto-Ticket Generator Events (Non-blocking v3.9.0)
        else if (type === 'auto_ticket_complete') {
          this.state.isAutoBuilding = false;
          const tickets = Array.isArray(e.data.tickets) && e.data.tickets.length > 0
            ? e.data.tickets
            : [{ id: 1, legs: generatedLegs || [], simResults: simResults || null }];

          this.state.generatedTickets = tickets;
          this.state.activeTicketIndex = 0;

          const activeTicket = tickets[0];
          this.parlayEngine.clearSlip();
          (activeTicket.legs || []).forEach(leg => this.parlayEngine.addLeg(leg));
          this.state.parlaySimResults = activeTicket.simResults;
          this.state.autoBuildAccordionOpen = false;

          const stratName = activeTicket.strategyClassification || (this.state.autoBuildStrategy === 'high_win' ? 'High Win %' : 'Best Value (+EV)');
          this.state.autoBuildStrategyClassification = stratName;
          if (tickets.length > 1) {
            this.showToast(`⚡ Auto-Generated ${tickets.length} Distinct Tickets (${stratName})! 🎯`);
          } else {
            this.showToast(`⚡ Auto-Generated ${(activeTicket.legs || []).length}-Leg Ticket (${stratName})! 🎯`);
          }

          this.renderParlaySlate();
          this.renderBetSlip();
        } else if (type === 'auto_ticket_error') {
          console.error('Worker auto-ticket error:', error);
          this.state.isAutoBuilding = false;
          this.runSyncAutoGenerateFallback(
            this.state.autoBuildLegs || 3,
            this.state.autoBuildStrategy || 'best_value',
            this.state.autoBuildTicketCount || 1
          );
        }
      };

      this.worker.onerror = (err) => {
        console.warn('Worker runtime error, falling back to sync:', err);
        if (this.state.isSimulating) this.runSyncFallback();
        if (this.state.isParlaySimulating) this.runSyncParlayFallback();
        if (this.state.isAutoBuilding) {
          this.state.isAutoBuilding = false;
          this.runSyncAutoGenerateFallback(
            this.state.autoBuildLegs || 3,
            this.state.autoBuildStrategy || 'best_value',
            this.state.autoBuildTicketCount || 1
          );
        }
      };
    } catch (e) {
      console.warn('Web Worker fallback:', e);
      this.worker = null;
    }
  }

  bindGlobalHandlers() {
    window.onPoolSizeInput = (val) => this.onPoolSizeInput(val);
    window.onStrategySelect = (strat) => this.onStrategySelect(strat);
    window.onWeekSelect = (week) => this.onWeekSelect(week);
    window.onPickemModeSelect = (mode) => this.onPickemModeSelect(mode);
    window.switchView = (view) => this.switchView(view);
    window.toggleLockPick = (week, teamCode) => this.toggleLockPick(week, teamCode);
    window.toggleExcludeTeam = (teamCode) => this.toggleExcludeTeam(teamCode);
    window.resetOverrides = () => this.resetOverrides();
    window.runMonteCarloSim = () => this.runMonteCarloSim();
    window.copySurvivorPath = () => this.copySurvivorPath();
    window.copyPickemSheet = () => this.copyPickemSheet();
    window.triggerBowieEasterEgg = (el) => this.triggerBowieEasterEgg(el);
    window.showUsedTeamToast = (teamCode, week) => this.showUsedTeamToast(teamCode, week);

    // Parlay & SGP Handlers
    window.toggleParlayLeg = (legJson) => this.toggleParlayLeg(legJson);
    window.removeParlayLeg = (legId) => this.removeParlayLeg(legId);
    window.clearBetSlip = () => this.clearBetSlip();
    window.onParlayFilterSelect = (filter) => this.onParlayFilterSelect(filter);
    window.onSlipStakeChange = (val) => this.onSlipStakeChange(val);
    window.setSlipStake = (val) => this.setSlipStake(val);
    window.onSlipOfferedOddsChange = (val) => this.onSlipOfferedOddsChange(val);
    window.resetSlipOfferedOdds = () => this.resetSlipOfferedOdds();
    window.resimulateBetSlip = () => this.resimulateBetSlip();
    window.copyParlayTicket = () => this.copyParlayTicket();
    window.toggleMobileBetSlip = (isOpen) => this.toggleMobileBetSlip(isOpen);

    // Auto-Generate Ticket Handlers
    window.onAutoBuildLegCountSelect = (count) => this.onAutoBuildLegCountSelect(count);
    window.onAutoBuildStrategySelect = (strat) => this.onAutoBuildStrategySelect(strat);
    window.onAutoBuildTicketCountSelect = (count) => this.onAutoBuildTicketCountSelect(count);
    window.onSelectTicketTab = (idx) => this.onSelectTicketTab(idx);
    window.toggleAutoBuildAccordion = () => this.toggleAutoBuildAccordion();
    window.autoGenerateTicket = () => this.autoGenerateTicket();
  }

  showUsedTeamToast(teamCode, usedWeek) {
    this.showToast(`⚠️ ${teamCode} is already picked in Week ${usedWeek}! Clicked to move lock to active week. 🔄`);
  }

  onPoolSizeInput(val) {
    const size = parseInt(val, 10) || 100;
    this.state.poolSize = size;
    const badge = document.getElementById('poolSizeVal');
    if (badge) badge.textContent = size.toLocaleString();

    const tag = document.getElementById('poolScaleTag');
    if (tag) {
      if (size <= 30) tag.textContent = 'Small Office Pool (Chalk Safe)';
      else if (size <= 250) tag.textContent = 'Mid-Size Pool (Balanced EV)';
      else if (size <= 1000) tag.textContent = 'Large Contest (Contrarian Leverage)';
      else tag.textContent = 'Mega Pool (Max Leverage)';
    }

    this.recalculateAll();
    this.renderAll();
    this.runMonteCarloSim();
  }

  onStrategySelect(strat) {
    this.state.strategy = strat;
    document.querySelectorAll('.strategy-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.strategy === strat);
    });

    this.recalculateAll();
    this.renderAll();
    this.runMonteCarloSim();
  }

  onWeekSelect(week) {
    this.state.activeWeek = parseInt(week, 10) || 1;
    const weekSelect = document.getElementById('weekSelect') || document.getElementById('activeWeekSelect');
    if (weekSelect) weekSelect.value = String(this.state.activeWeek);

    this.recalculateWeeklyViews();
    this.renderSpotlightCards();
    this.renderWeeklySlateTable();
    this.renderPickemConfidenceTable();
    this.renderParlaySlate();
    this.renderOddsSyncStatus();
  }

  onPickemModeSelect(mode) {
    this.state.pickemMode = mode;
    document.querySelectorAll('#pickemModeSelector .strategy-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const badge = document.getElementById('pickemModeBadge');
    const sub = document.getElementById('pickemSubtitle');
    if (badge) {
      badge.textContent = mode === 'ats' ? 'AGAINST THE SPREAD (ATS)' : 'STRAIGHT UP (SU)';
      badge.className = `spotlight-tag ${mode === 'ats' ? 'tag-chalk' : 'tag-leverage'}`;
    }
    if (sub) {
      sub.textContent = mode === 'ats'
        ? 'Optimal 16-to-1 ATS confidence point allocation exploiting public favorite bias and sharp line-cover probabilities.'
        : 'Optimal 16-to-1 confidence point allocation maximizing pool EV based on Vegas moneyline win probability and national pick leverage.';
    }

    this.recalculateWeeklyViews();
    this.renderPickemConfidenceTable();
  }

  switchView(view) {
    this.state.currentView = view;
    document.querySelectorAll('.view-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.view === view);
    });

    document.getElementById('survivorView').style.display = view === 'survivor' ? 'block' : 'none';
    document.getElementById('pickemView').style.display = view === 'pickem' ? 'block' : 'none';
    document.getElementById('parlayView').style.display = view === 'parlay' ? 'block' : 'none';

    if (view === 'pickem') {
      this.renderPickemConfidenceTable();
    } else if (view === 'parlay') {
      this.renderParlaySlate();
      this.renderBetSlip();
      if (this.parlayEngine.legs.length > 0 && !this.state.parlaySimResults) {
        this.resimulateBetSlip();
      }
    }

    this.renderHeaderAdvice();
  }

  toggleLockPick(week, teamCode) {
    const w = parseInt(week, 10);
    if (!teamCode || teamCode === '—') return;

    if (this.state.lockedPicks[w] === teamCode) {
      delete this.state.lockedPicks[w];
      this.showToast(`Unlocked Week ${w} pick (${teamCode}). 🔓`);
    } else {
      let prevLockedWeek = null;
      Object.keys(this.state.lockedPicks).forEach(otherW => {
        if (this.state.lockedPicks[otherW] === teamCode && parseInt(otherW, 10) !== w) {
          prevLockedWeek = otherW;
          delete this.state.lockedPicks[otherW];
        }
      });

      this.state.lockedPicks[w] = teamCode;
      this.state.excludedTeams.delete(teamCode);

      if (prevLockedWeek) {
        this.showToast(`Moved ${teamCode} from Week ${prevLockedWeek} to Week ${w}! 🔒`);
      } else {
        this.showToast(`Locked ${teamCode} to Week ${w}! 🔒`);
      }
    }

    this.recalculateAll();
    this.renderAll();
    this.runMonteCarloSim();
  }

  toggleExcludeTeam(teamCode) {
    if (this.state.excludedTeams.has(teamCode)) {
      this.state.excludedTeams.delete(teamCode);
      this.showToast(`Restored ${teamCode} to candidate pool. ✅`);
    } else {
      this.state.excludedTeams.add(teamCode);
      Object.keys(this.state.lockedPicks).forEach(w => {
        if (this.state.lockedPicks[w] === teamCode) delete this.state.lockedPicks[w];
      });
      this.showToast(`Excluded ${teamCode} from all survivor paths. 🚫`);
    }

    this.recalculateAll();
    this.renderAll();
    this.runMonteCarloSim();
  }

  resetOverrides() {
    this.state.lockedPicks = {};
    this.state.excludedTeams.clear();
    this.showToast('Reset all locks and exclusions to optimal default. 🔄');
    this.recalculateAll();
    this.renderAll();
    this.runMonteCarloSim();
  }

  recalculateAll() {
    if (!this.state.slateData || this.state.slateData.length === 0) return;

    this.state.currentPathResult = this.engine.findOptimal18WeekPath(this.state.slateData, {
      poolSize: this.state.poolSize,
      strategy: this.state.strategy,
      lockedPicks: this.state.lockedPicks,
      excludedTeams: Array.from(this.state.excludedTeams)
    });

    this.recalculateWeeklyViews();
  }

  recalculateWeeklyViews() {
    const horizon = this.state.currentPathResult?.targetHorizon || 18;
    this.state.weeklySpotlight = this.engine.categorizeWeeklyPicks(this.state.activeWeek, this.state.slateData, {
      poolSize: this.state.poolSize,
      targetHorizon: horizon
    });

    this.state.pickemConfidence = this.engine.generatePickemConfidence(
      this.state.activeWeek, 
      this.state.slateData, 
      this.state.pickemMode || 'straight_up'
    );
  }

  runMonteCarloSim() {
    if (!this.state.currentPathResult || !this.state.slateData) return;

    this.state.isSimulating = true;
    const simBtn = document.getElementById('runSimBtn');
    if (simBtn) {
      simBtn.innerHTML = '<span>⚡ Simulating 10,000 Pools...</span>';
      simBtn.disabled = true;
    }

    const horizon = this.state.currentPathResult.targetHorizon || 11;

    if (this.worker) {
      try {
        this.worker.postMessage({
          action: 'SIMULATE_SURVIVOR',
          path: this.state.currentPathResult.path,
          slateData: this.state.slateData,
          poolSize: this.state.poolSize,
          iterations: 10000,
          targetHorizon: horizon
        });
        return;
      } catch (e) {
        console.warn('Worker postMessage failed, falling back to sync:', e);
      }
    }

    this.runSyncFallback();
  }

  runSyncFallback() {
    setTimeout(() => {
      const horizon = this.state.currentPathResult?.targetHorizon || 11;
      const results = this.runSyncFallbackSim(
        this.state.currentPathResult.path,
        this.state.slateData,
        this.state.poolSize,
        10000,
        horizon
      );
      this.state.simResults = results;
      this.state.isSimulating = false;
      this.renderSimulationResults();
    }, 40);
  }

  runSyncFallbackSim(userPath, slateData, poolSize, iterations, targetHorizon) {
    const userPicksByWeek = {};
    userPath.forEach(p => { userPicksByWeek[p.week] = p.teamCode; });
    const totalPoolSize = Math.max(2, Math.min(10000, Number(poolSize) || 100));
    const numOpponents = totalPoolSize - 1;

    let totalWinEquity = 0;
    let userSurvivedHorizon = 0;
    let userSurvived18 = 0;
    const poolEndWeeks = [];

    for (let iter = 1; iter <= iterations; iter++) {
      let userAlive = true;
      let opponentsAlive = numOpponents;
      let poolFinishWeek = 18;
      let poolEndedEarly = false;

      for (let w = 1; w <= 18; w++) {
        const weekData = slateData.find(s => s.week === w);
        if (!weekData) continue;

        const gameOutcomes = {};
        weekData.games.forEach(g => {
          const homeWon = Math.random() < g.homeWinProb;
          gameOutcomes[g.homeTeam] = homeWon;
          gameOutcomes[g.awayTeam] = !homeWon;
        });

        const myTeam = userPicksByWeek[w];
        const userSurvivesThisWeek = (myTeam && myTeam !== '—' && gameOutcomes[myTeam] === true);

        let survivingOpponents = 0;
        if (opponentsAlive > 0) {
          const pickDist = [];
          let cum = 0;
          weekData.games.forEach(g => {
            cum += g.homePickPct; pickDist.push({ team: g.homeTeam, cum, won: gameOutcomes[g.homeTeam] });
            cum += g.awayPickPct; pickDist.push({ team: g.awayTeam, cum, won: gameOutcomes[g.awayTeam] });
          });

          for (let opp = 0; opp < opponentsAlive; opp++) {
            const r = Math.random() * (cum || 1.0);
            const picked = pickDist.find(p => r <= p.cum) || pickDist[pickDist.length - 1];
            if (picked && picked.won) survivingOpponents++;
          }
        }

        if (w === targetHorizon && userAlive && userSurvivesThisWeek) {
          userSurvivedHorizon++;
        }

        if (userAlive && !userSurvivesThisWeek) {
          userAlive = false;
          if (survivingOpponents === 0 && opponentsAlive > 0) {
            totalWinEquity += (1 / (1 + opponentsAlive));
            poolFinishWeek = w;
            poolEndedEarly = true;
            break;
          }
        } else if (userAlive && userSurvivesThisWeek) {
          if (survivingOpponents === 0) {
            totalWinEquity += 1.0;
            poolFinishWeek = w;
            poolEndedEarly = true;
            break;
          }
        }

        opponentsAlive = survivingOpponents;
        if (!userAlive && opponentsAlive === 0) {
          poolFinishWeek = w;
          poolEndedEarly = true;
          break;
        }
      }

      if (!poolEndedEarly) {
        poolFinishWeek = 18;
        if (userAlive) {
          userSurvived18++;
          totalWinEquity += (1 / (1 + opponentsAlive));
        }
      }

      poolEndWeeks.push(poolFinishWeek);
    }

    const avgPoolEnd = Number((poolEndWeeks.reduce((a, b) => a + b, 0) / iterations).toFixed(1));
    const winEquityPct = Number(((totalWinEquity / iterations) * 100).toFixed(2));
    const randomBaselinePct = Number(((1 / totalPoolSize) * 100).toFixed(2));
    const edgeMultiple = Number((winEquityPct / Math.max(0.001, randomBaselinePct)).toFixed(1));

    return {
      iterations,
      poolSize: totalPoolSize,
      winEquityPct,
      randomBaselinePct,
      edgeMultiple,
      expectedPoolEndWeek: avgPoolEnd,
      picksNeededToWin: Math.round(avgPoolEnd),
      horizonSurvivalPct: Number(((userSurvivedHorizon / iterations) * 100).toFixed(1)),
      fullSeasonSurvivalPct: Number(((userSurvived18 / iterations) * 100).toFixed(2)),
      targetHorizon
    };
  }

  updateSimProgress(pct) {
    const simBtn = document.getElementById('runSimBtn');
    if (simBtn) {
      simBtn.innerHTML = `<span>⚡ Simulating (${pct}%)...</span>`;
    }
  }

  renderAll() {
    this.renderHeaderAdvice();
    this.renderSpotlightCards();
    this.renderArsenalBar();
    this.renderWeeklySlateTable();
    this.renderPathMatrix();
    this.renderPickemConfidenceTable();
    this.renderSimulationResults();
    this.renderParlaySlate();
    this.renderBetSlip();
    this.renderOddsSyncStatus();
  }

  renderOddsSyncStatus() {
    const indicator = document.getElementById('oddsSyncIndicator');
    if (!indicator) return;

    const currentWeekNum = this.state.activeWeek || 1;
    const weekData = (this.state.slateData || []).find(w => w.week === currentWeekNum);
    const gameCount = weekData && Array.isArray(weekData.games) ? weekData.games.length : 16;

    const metadata = this.state.slateMetadata || {};
    const syncStatus = metadata.syncStatus || 'COMPLETE';
    const isComplete = syncStatus === 'COMPLETE';

    let timeDisplay = 'Live';
    if (metadata.lastSyncedAt) {
      try {
        const d = new Date(metadata.lastSyncedAt);
        timeDisplay = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      } catch (e) {
        timeDisplay = 'Live';
      }
    }

    indicator.className = `odds-sync-indicator ${isComplete ? 'complete' : 'partial'}`;
    indicator.innerHTML = `
      <span class="odds-sync-dot">●</span>
      <span id="oddsSyncText">Odds Synced: ${gameCount}/${gameCount} Games (${timeDisplay})</span>
    `;
    indicator.title = `Live Odds Consensus: ${isComplete ? '100% Complete' : 'Partial'} (Last synced: ${metadata.lastSyncedAt || 'Live'})`;
  }

  renderWeeklySpotlight() {
    this.renderSpotlightCards();
  }

  renderArsenalBar() {
    const bar = document.getElementById('arsenalBar');
    if (!bar || !this.state.currentPathResult) return;

    const horizonWeek = this.state.currentPathResult.targetHorizon || 11;
    const numLocks = Object.keys(this.state.lockedPicks).length;

    bar.innerHTML = `
      <div class="arsenal-info">
        <span style="font-size:16px;">🗺️</span>
        <span style="letter-spacing:0.02em;color:#fff;">STRATEGY PATHFINDER:</span>
        <span class="badge-lock-count"><strong>${numLocks}</strong> ${numLocks === 1 ? 'Active Lock' : 'Active Locks'}</span>
        <span class="arsenal-divider">•</span>
        <span style="color:var(--text-dim);font-size:12px;">Optimal Target Horizon: <strong style="color:var(--gold-bright);">Week ${horizonWeek} Finish Line</strong></span>
      </div>
      <div class="arsenal-sub">
        💡 <strong>Tip:</strong> Click any matchup cell to <strong>Lock (🔒)</strong> a pick. The engine instantly recalculates the optimal path forward around your selections.
      </div>
    `;
  }

  renderHeaderAdvice() {
    const adviceEl = document.getElementById('bowieSpeech');
    if (!adviceEl) return;

    if (this.state.currentView === 'parlay') {
      const legCount = this.parlayEngine.legs.length;
      if (legCount === 0) {
        adviceEl.textContent = `"Welcome to the Parlay & SGP Lab! Select spread, total, or moneyline pills to test correlated game scripts and find +EV edges." 🐾`;
      } else {
        const classification = this.parlayEngine.getTicketClassification();
        adviceEl.textContent = `"Analyzing ${legCount}-leg ${classification.label} across 10,000 synchronized Monte Carlo iterations." 🦴`;
      }
      return;
    }

    if (this.state.currentView === 'pickem') {
      adviceEl.textContent = this.state.pickemMode === 'ats'
        ? `"In ATS Pick'em pools, look for contrarian underdogs where the public heavily over-backs favorites!" ⚖️🐾`
        : `"In Straight Up Pick'em, assign your highest 16-to-1 confidence points to safest favorites while fading traps." 🎯🐾`;
      return;
    }

    const size = this.state.poolSize;
    const horizon = this.state.currentPathResult?.targetHorizon || 11;
    let text = '';

    if (size <= 40) {
      text = `"In a ${size}-person pool, the field is expected to be wiped out by Week ${horizon}. Don't save elite teams for December—deploy them now!" 🐾`;
    } else if (size <= 300) {
      text = `"In a ${size}-entry pool, aim for Week ${horizon}. Look for 1 or 2 high-EV leverage pivots while reserving top tier teams for the Week ${horizon} finish line." 🦴`;
    } else {
      text = `"In a massive ${size.toLocaleString()}-entry contest, the pool will likely last through Week 17–18. Fade heavy 30%+ national chalk to maximize your solo equity!" 🚀`;
    }

    adviceEl.textContent = text;
  }

  renderSpotlightCards() {
    const container = document.getElementById('spotlightGrid');
    if (!container || !this.state.weeklySpotlight) return;

    const { leverage, chalk, trap } = this.state.weeklySpotlight;

    const formatEv = (val) => {
      if (val === undefined || val === null || val === '—') return '—';
      const num = Number(val);
      return isNaN(num) ? '—' : (num >= 0 ? `+${num.toFixed(2)}` : `${num.toFixed(2)}`);
    };

    const renderCard = (data, title, tagClass, tagText, subText, borderClass) => {
      const team = data?.teamCode || data?.team;
      if (!data || !team) {
        return `
          <div class="spotlight-card ${borderClass}">
            <div class="spotlight-badge-row">
              <span class="spotlight-title">${title}</span>
              <span class="spotlight-tag ${tagClass}">${tagText}</span>
            </div>
            <div style="color:var(--muted);font-size:13px;margin:20px 0;">No active matchup for this category.</div>
          </div>
        `;
      }

      const opp = data.oppCode || data.oppTeam || data.opponent || 'OPP';
      const spread = data.spread !== undefined ? (data.spread > 0 ? `+${data.spread}` : `${data.spread}`) : '—';
      const winProb = data.winProb !== undefined ? `${Math.round(data.winProb * 100)}%` : '—';
      const pickPct = data.pickPct !== undefined ? `${(data.pickPct * 100).toFixed(1)}%` : '—';
      const evVal = formatEv(data.ev !== undefined ? data.ev : data.expectedValue);

      const isLocked = this.state.lockedPicks[this.state.activeWeek] === team;
      const isOptimal = this.state.currentPathResult?.path?.some(p => p.week === this.state.activeWeek && p.teamCode === team);

      return `
        <div class="spotlight-card ${borderClass}">
          <div class="spotlight-badge-row">
            <span class="spotlight-title">${title}</span>
            <span class="spotlight-tag ${tagClass}">${tagText}</span>
          </div>
          <div class="spotlight-team-row">
            <div class="spotlight-team">${team}</div>
            <div class="spotlight-matchup">vs ${opp} (${spread})</div>
          </div>
          <div class="spotlight-stats-grid">
            <div class="spotlight-stat-box">
              <div class="spotlight-stat-val">${winProb}</div>
              <div class="spotlight-stat-lbl">Win Prob</div>
            </div>
            <div class="spotlight-stat-box">
              <div class="spotlight-stat-val">${pickPct}</div>
              <div class="spotlight-stat-lbl">Public Pick %</div>
            </div>
            <div class="spotlight-stat-box">
              <div class="spotlight-stat-val" style="color:var(--accent);">${evVal}</div>
              <div class="spotlight-stat-lbl">Pool EV</div>
            </div>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-bottom:12px;line-height:1.3;">
            ${subText}
          </div>
          <button class="btn-lock ${isLocked ? 'locked' : ''}" onclick="toggleLockPick(${this.state.activeWeek}, '${team}')">
            <span>${isLocked ? '🔒 Locked to Week ' + this.state.activeWeek : (isOptimal ? '⭐ Optimal Pick (Click to Lock)' : '🔒 Lock ' + team)}</span>
          </button>
        </div>
      `;
    };

    container.innerHTML = `
      ${renderCard(leverage, '⚡ Top Leverage Play', 'tag-leverage', 'HIGH EV', 'High win probability with low national ownership to leapfrog opponents.', 'card-leverage')}
      ${renderCard(chalk, '🛡️ Chalk / Consensus Safe', 'tag-chalk', 'CONSENSUS', 'Heavy favorite pick to maximize raw survival probability.', 'card-chalk')}
      ${renderCard(trap, '⚠️ Trap Game Alert', 'tag-trap', 'FADE RISK', 'Dangerously over-owned by public relative to true moneyline win probability.', 'card-trap')}
    `;
  }

  renderWeeklySlateTable() {
    const tbody = document.getElementById('weeklySlateBody');
    if (!tbody || !this.state.slateData) return;

    const weekData = this.state.slateData.find(s => s.week === this.state.activeWeek);
    if (!weekData || !weekData.games) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:20px;">No slate data available for Week ${this.state.activeWeek}.</td></tr>`;
      return;
    }

    const teamRows = [];
    weekData.games.forEach(g => {
      const homeSpread = g.spread;
      const awaySpread = -homeSpread;
      const fvHome = this.engine.calculateFutureValue(g.homeTeam, this.state.activeWeek, this.state.slateData, this.state.currentPathResult?.targetHorizon || 11);
      const fvAway = this.engine.calculateFutureValue(g.awayTeam, this.state.activeWeek, this.state.slateData, this.state.currentPathResult?.targetHorizon || 11);

      teamRows.push({
        team: g.homeTeam,
        opp: `@ ${g.awayTeam}`,
        spread: homeSpread > 0 ? `+${homeSpread}` : `${homeSpread}`,
        winProb: g.homeWinProb,
        pickPct: g.homePickPct,
        ev: this.engine.calculateEV(g.homeWinProb, g.homePickPct, this.state.poolSize),
        futureValue: fvHome
      });

      teamRows.push({
        team: g.awayTeam,
        opp: `vs ${g.homeTeam}`,
        spread: awaySpread > 0 ? `+${awaySpread}` : `${awaySpread}`,
        winProb: g.awayWinProb,
        pickPct: g.awayPickPct,
        ev: this.engine.calculateEV(g.awayWinProb, g.awayPickPct, this.state.poolSize),
        futureValue: fvAway
      });
    });

    teamRows.sort((a, b) => b.ev - a.ev);

    tbody.innerHTML = teamRows.map(row => {
      const isLocked = this.state.lockedPicks[this.state.activeWeek] === row.team;
      const isExcluded = this.state.excludedTeams.has(row.team);
      const isOptimal = this.state.currentPathResult?.path?.some(p => p.week === this.state.activeWeek && p.teamCode === row.team);

      let rowClass = '';
      if (isLocked) rowClass = 'row-locked';
      else if (isOptimal) rowClass = 'row-optimal';
      else if (isExcluded) rowClass = 'row-excluded';

      return `
        <tr class="${rowClass}">
          <td style="font-weight:800;color:#fff;">
            <span>${row.team}</span>
            ${isLocked ? '<span style="font-size:11px;margin-left:4px;">🔒</span>' : ''}
            ${isOptimal && !isLocked ? '<span style="font-size:11px;margin-left:4px;">⭐</span>' : ''}
          </td>
          <td style="color:var(--text-dim);">${row.opp}</td>
          <td style="font-family:var(--font-mono);">${row.spread}</td>
          <td>
            <span style="font-weight:700;color:${row.winProb >= 0.75 ? 'var(--accent)' : (row.winProb >= 0.6 ? 'var(--gold-bright)' : 'var(--text-dim)')};">
              ${(row.winProb * 100).toFixed(0)}%
            </span>
          </td>
          <td style="font-family:var(--font-mono);">${(row.pickPct * 100).toFixed(1)}%</td>
          <td>
            <span style="font-weight:800;color:${row.ev >= 1.2 ? 'var(--accent)' : (row.ev >= 1.0 ? 'var(--gold-bright)' : 'var(--danger)')};">
              ${row.ev >= 0 ? '+' : ''}${row.ev.toFixed(2)}
            </span>
          </td>
          <td style="color:var(--text-dim);font-size:12px;">${row.futureValue.toFixed(1)}</td>
          <td style="text-align:right;">
            <div style="display:inline-flex;gap:6px;">
              <button class="btn-table-action ${isLocked ? 'active' : ''}" onclick="toggleLockPick(${this.state.activeWeek}, '${row.team}')" title="Lock ${row.team} to Week ${this.state.activeWeek}">
                ${isLocked ? '🔓 Unlock' : '🔒 Lock'}
              </button>
              <button class="btn-table-action ${isExcluded ? 'active-exclude' : ''}" onclick="toggleExcludeTeam('${row.team}')" title="Exclude ${row.team}">
                ${isExcluded ? '✅ Include' : '🚫 Fade'}
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  renderPathMatrix() {
    const theadRow = document.getElementById('matrixHeaderRow');
    const tbody = document.getElementById('matrixBody');
    if (!theadRow || !tbody || !this.state.slateData) return;

    const horizon = this.state.currentPathResult?.targetHorizon || 11;
    const optimalPathMap = {};
    if (this.state.currentPathResult?.path) {
      this.state.currentPathResult.path.forEach(p => {
        optimalPathMap[p.week] = p.teamCode;
      });
    }

    // Header: Team + W1-W18
    let headerHtml = `<th style="width:70px;position:sticky;left:0;background:var(--panel);z-index:5;">Team</th>`;
    for (let w = 1; w <= 18; w++) {
      const isFinishLine = (w === horizon);
      headerHtml += `
        <th class="${isFinishLine ? 'col-finish-line' : ''}">
          <div>W${w}</div>
          ${isFinishLine ? '<div style="font-size:8px;color:var(--gold);font-weight:800;margin-top:1px;">🏁 FINISH</div>' : ''}
        </th>
      `;
    }
    theadRow.innerHTML = headerHtml;

    // Collect all 32 NFL Teams
    const teams = [
      'ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB',
      'HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG',
      'NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'
    ];

    tbody.innerHTML = teams.map(team => {
      let rowHtml = `
        <td style="font-weight:800;position:sticky;left:0;background:var(--panel);z-index:4;color:#fff;border-right:1px solid var(--border);">
          ${team}
        </td>
      `;

      for (let w = 1; w <= 18; w++) {
        const weekData = this.state.slateData.find(s => s.week === w);
        let cellContent = '—';
        let cellClass = '';
        let titleTip = '';

        if (weekData && weekData.games) {
          const game = weekData.games.find(g => g.homeTeam === team || g.awayTeam === team);
          if (game) {
            const isHome = game.homeTeam === team;
            const opp = isHome ? game.awayTeam : game.homeTeam;
            const spread = isHome ? game.spread : -game.spread;
            const winProb = isHome ? game.homeWinProb : game.awayWinProb;

            const isLockedThisWeek = this.state.lockedPicks[w] === team;
            const isOptimalThisWeek = optimalPathMap[w] === team;
            const isFinishLine = (w === horizon);

            if (isLockedThisWeek) {
              cellClass = 'cell-locked';
              cellContent = `🔒 ${isHome ? '' : '@'}${opp}`;
            } else if (isOptimalThisWeek) {
              cellClass = 'cell-optimal';
              cellContent = `⭐ ${isHome ? '' : '@'}${opp}`;
            } else if (winProb >= 0.75) {
              cellClass = 'cell-elite';
              cellContent = `${isHome ? '' : '@'}${opp}`;
            } else if (winProb >= 0.65) {
              cellClass = 'cell-fav';
              cellContent = `${isHome ? '' : '@'}${opp}`;
            } else {
              cellContent = `${isHome ? '' : '@'}${opp}`;
            }

            if (isFinishLine) {
              cellClass += ' cell-finish-col';
            }

            titleTip = `${team} vs ${opp} (Week ${w}) | Spread: ${spread > 0 ? '+' + spread : spread} | Win Prob: ${Math.round(winProb * 100)}%`;
          }
        }

        rowHtml += `
          <td class="${cellClass}" title="${titleTip}" onclick="toggleLockPick(${w}, '${team}')">
            ${cellContent}
          </td>
        `;
      }

      return `<tr>${rowHtml}</tr>`;
    }).join('');
  }

  renderPickemConfidenceTable() {
    const thead = document.getElementById('pickemThead');
    const tbody = document.getElementById('pickemTableBody');
    const titleEl = document.getElementById('pickemTableTitle');
    const subEl = document.getElementById('pickemTableSubtitle');
    if (!tbody || !this.state.pickemConfidence) return;

    const isATS = this.state.pickemMode === 'ats';

    if (titleEl) {
      titleEl.innerHTML = `<span>📋 Week ${this.state.activeWeek} Pick'em Confidence Rankings (${isATS ? 'Against the Spread' : 'Straight Up'})</span>`;
    }
    if (subEl) {
      subEl.textContent = isATS
        ? 'Ranked 16 down to 1 points based on point spread cover probability and contrarian ticket leverage.'
        : 'Ranked 16 down to 1 points based on Vegas moneyline win probability and national pick ownership.';
    }

    if (thead) {
      if (isATS) {
        thead.innerHTML = `
          <tr>
            <th style="width:70px;">Points</th>
            <th>Selected Pick (ATS)</th>
            <th>Opponent</th>
            <th>Spread Line</th>
            <th>Cover Probability</th>
            <th>Public ATS %</th>
            <th>ATS Leverage Edge</th>
            <th style="text-align:right;">Strategy Rating</th>
          </tr>
        `;
      } else {
        thead.innerHTML = `
          <tr>
            <th style="width:70px;">Points</th>
            <th>Selected Pick (SU)</th>
            <th>Opponent</th>
            <th>Vegas Spread</th>
            <th>Win Probability</th>
            <th>Public Pick %</th>
            <th>Leverage Edge</th>
            <th style="text-align:right;">Strategy Rating</th>
          </tr>
        `;
      }
    }

    const list = Array.isArray(this.state.pickemConfidence) 
      ? this.state.pickemConfidence 
      : (this.state.pickemConfidence.rankedGames || []);

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:20px;">No Pick'em data available for Week ${this.state.activeWeek}.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(item => {
      const points = item.confidence || item.confidencePoints || '—';
      const pick = item.pickedTeam || item.selectedPick || '—';
      const opp = item.oppTeam || item.opponent || '—';
      const spreadFormatted = item.spreadFormatted || (item.spread !== undefined ? (item.spread > 0 ? `+${item.spread}` : `${item.spread}`) : '—');
      
      const probVal = isATS 
        ? (item.coverProb !== undefined ? `${(item.coverProb * 100).toFixed(1)}%` : '—')
        : (item.winProb !== undefined ? `${Math.round(item.winProb * 100)}%` : '—');

      const pubPct = item.publicPickPct !== undefined 
        ? `${(item.publicPickPct * 100).toFixed(1)}%` 
        : (item.pickPct !== undefined ? `${(item.pickPct * 100).toFixed(1)}%` : '—');

      const edge = item.leverageEdge !== undefined 
        ? `${item.leverageEdge >= 0 ? '+' : ''}${item.leverageEdge}%` 
        : (item.edge !== undefined ? `${item.edge >= 0 ? '+' : ''}${item.edge}%` : '—');

      const stratTag = item.stratTag || (item.isLeveragePlay ? '⚡ TOP LEVERAGE' : 'CHALK');
      const stratClass = item.stratClass || (item.isLeveragePlay ? 'tag-leverage' : 'tag-chalk');

      const pickDisplay = isATS ? `${pick} <span style="color:var(--gold);font-family:var(--font-mono);font-size:12px;margin-left:4px;">${spreadFormatted}</span>` : pick;
      const oppDisplay = isATS 
        ? `${item.isHome ? 'vs' : '@'} ${opp} <span style="color:var(--text-dim);font-family:var(--font-mono);font-size:11px;">(${item.oppSpreadFormatted || ''})</span>`
        : `${item.isHome ? 'vs' : '@'} ${opp}`;

      let probColor = 'var(--text-dim)';
      if (isATS) {
        if (item.coverProb >= 0.54) probColor = 'var(--accent)';
        else if (item.coverProb >= 0.50) probColor = 'var(--gold-bright)';
      } else {
        if (item.winProb >= 0.75) probColor = 'var(--accent)';
        else if (item.winProb >= 0.60) probColor = 'var(--gold-bright)';
      }

      const edgeColor = (item.leverageEdge >= 5.0 || item.edge >= 8.0) ? 'var(--cyan)' : (item.leverageEdge < -10.0 ? 'var(--danger)' : 'var(--muted)');

      return `
        <tr>
          <td style="font-weight:800;color:var(--gold-bright);font-family:var(--font-mono);font-size:14px;">
            ${points}
          </td>
          <td style="font-weight:800;color:#fff;">
            ${pickDisplay}
          </td>
          <td style="color:var(--text-dim);">${oppDisplay}</td>
          <td style="font-family:var(--font-mono);font-size:12px;color:var(--text);">${spreadFormatted}</td>
          <td style="font-weight:700;color:${probColor};">${probVal}</td>
          <td style="font-family:var(--font-mono);">${pubPct}</td>
          <td style="font-weight:700;color:${edgeColor};font-family:var(--font-mono);">
            ${edge}
          </td>
          <td style="text-align:right;">
            <span class="spotlight-tag ${stratClass}" style="margin:0;font-size:10px;">${stratTag}</span>
          </td>
        </tr>
      `;
    }).join('');
  }

  renderSimulationResults() {
    const simBtn = document.getElementById('runSimBtn');
    if (simBtn) {
      simBtn.innerHTML = '<span>⚡ Re-Run 10k Monte Carlo</span>';
      simBtn.disabled = false;
    }

    const r = this.state.simResults || {};
    const poolSize = r.poolSize || this.state.poolSize || 100;
    const horizon = r.targetHorizon || this.state.currentPathResult?.targetHorizon || this.engine.estimatePoolFinishWeek(poolSize);
    
    // Robust defensive fallbacks
    const baselinePct = r.randomBaselinePct !== undefined ? r.randomBaselinePct : Number(((1 / poolSize) * 100).toFixed(2));
    const winEquity = r.winEquityPct !== undefined ? r.winEquityPct : Number(((1.8 / poolSize) * 100).toFixed(2));
    const edgeMult = r.edgeMultiple !== undefined ? r.edgeMultiple : Number((winEquity / Math.max(0.001, baselinePct)).toFixed(1));
    const finishWeek = r.expectedPoolEndWeek !== undefined ? r.expectedPoolEndWeek : (r.expectedElimWeek !== undefined ? r.expectedElimWeek : horizon);
    const horizonOdds = r.horizonSurvivalPct !== undefined ? r.horizonSurvivalPct : (this.state.currentPathResult?.horizonSurvivalProb !== undefined ? this.state.currentPathResult.horizonSurvivalProb : 5.4);

    const equityEl = document.getElementById('simWinEquity');
    const edgeSubEl = document.getElementById('simEdgeSub');
    const finishEl = document.getElementById('simExpectedFinish');
    const finishSubEl = document.getElementById('simFinishSub');
    const oddsEl = document.getElementById('simHorizonOdds');
    const oddsSubEl = document.getElementById('simOddsSub');

    const roundedFinish = Math.round(finishWeek);

    if (equityEl) equityEl.textContent = `${winEquity}%`;
    if (edgeSubEl) edgeSubEl.textContent = `${edgeMult}x higher chance to win 1st place than average entry (${baselinePct}%)`;
    if (finishEl) finishEl.textContent = `Week ${roundedFinish}`;
    if (finishSubEl) finishSubEl.textContent = `In a ${poolSize}-person pool, all opponents are projected out by Week ${roundedFinish}`;
    if (oddsEl) oddsEl.textContent = `${horizonOdds}%`;
    if (oddsSubEl) oddsSubEl.textContent = `Odds of making it through Week ${roundedFinish} without a single loss`;
  }

  // ==========================================
  // ⚡ PARLAY & SAME-GAME PARLAY (SGP) CONTROLLER
  // ==========================================

  onParlayFilterSelect(filter) {
    this.state.parlayFilter = filter;
    document.querySelectorAll('.filter-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.filter === filter);
    });
    this.renderParlaySlate();
  }

  toggleParlayLeg(leg) {
    if (!leg) return;
    const result = this.parlayEngine.toggleLeg(leg);

    if (result.action === 'added') {
      this.showToast(`⚡ Added ${leg.label} to Bet Slip!`);
    } else if (result.action === 'removed') {
      this.showToast(`🗑️ Removed ${leg.label} from Bet Slip.`);
    } else if (result.action === 'replaced') {
      this.showToast(`🔄 Replaced ${result.replacedLeg?.label || 'previous leg'} with ${leg.label}!`);
    }

    if (this.state.generatedTickets.length > 0 && this.state.generatedTickets[this.state.activeTicketIndex]) {
      this.state.generatedTickets[this.state.activeTicketIndex].legs = [...this.parlayEngine.legs];
      const uncorr = this.parlayEngine.calculateUncorrelatedBookOdds();
      this.state.generatedTickets[this.state.activeTicketIndex].combinedOdds = uncorr.combinedAmerican;
      this.state.generatedTickets[this.state.activeTicketIndex].formattedOdds = this.parlayEngine.formatAmerican(uncorr.combinedAmerican);
    }

    this.renderParlaySlate();
    this.renderBetSlip();
    this.resimulateBetSlip();
  }

  removeParlayLeg(legId) {
    const removed = this.parlayEngine.removeLeg(legId);
    if (removed) {
      this.showToast(`🗑️ Removed ${removed.label} from Bet Slip.`);
    }

    if (this.state.generatedTickets.length > 0 && this.state.generatedTickets[this.state.activeTicketIndex]) {
      this.state.generatedTickets[this.state.activeTicketIndex].legs = [...this.parlayEngine.legs];
      const uncorr = this.parlayEngine.calculateUncorrelatedBookOdds();
      this.state.generatedTickets[this.state.activeTicketIndex].combinedOdds = uncorr.combinedAmerican;
      this.state.generatedTickets[this.state.activeTicketIndex].formattedOdds = this.parlayEngine.formatAmerican(uncorr.combinedAmerican);
    }

    this.renderParlaySlate();
    this.renderBetSlip();
    this.resimulateBetSlip();
  }

  clearBetSlip() {
    this.parlayEngine.clearSlip();
    this.state.parlaySimResults = null;
    this.state.generatedTickets = [];
    this.state.activeTicketIndex = 0;
    this.renderParlaySlate();
    this.renderBetSlip();
    this.showToast('🗑️ Cleared all legs from Bet Slip.');
  }

  onSlipStakeChange(val) {
    const stake = parseFloat(val) || 10;
    this.parlayEngine.stake = Math.max(1, stake);
    this.renderBetSlip();
  }

  setSlipStake(stake) {
    this.parlayEngine.stake = Number(stake) || 10;
    const input = document.getElementById('slipStakeInput');
    if (input) input.value = this.parlayEngine.stake;
    this.renderBetSlip();
  }

  onSlipOfferedOddsChange(val) {
    const cleanStr = String(val).trim().replace('+', '');
    const num = parseInt(cleanStr, 10);
    if (!isNaN(num) && num !== 0) {
      this.parlayEngine.customOfferedOdds = num;
      this.showToast(`Updated Sportsbook Offer: ${this.parlayEngine.formatAmerican(num)} 🎯`);
    } else {
      this.parlayEngine.customOfferedOdds = null;
    }
    this.renderBetSlip();
  }

  resetSlipOfferedOdds() {
    this.parlayEngine.customOfferedOdds = null;
    this.showToast('Reset to standard bookmaker multiplier. ↺');
    this.renderBetSlip();
  }

  resimulateBetSlip() {
    if (this.parlayEngine.legs.length === 0) {
      this.state.parlaySimResults = null;
      this.renderBetSlip();
      return;
    }

    this.state.isParlaySimulating = true;
    const badge = document.getElementById('slipSimStatusBadge');
    if (badge) badge.textContent = '⚡ Simulating 10,000 Runs...';

    if (this.worker) {
      try {
        this.worker.postMessage({
          action: 'SIMULATE_PARLAY',
          legs: this.parlayEngine.legs,
          slateData: this.state.slateData,
          iterations: 10000
        });
        return;
      } catch (e) {
        console.warn('Worker parlay sim postMessage failed, falling back to sync:', e);
      }
    }

    this.runSyncParlayFallback();
  }

  runSyncParlayFallback() {
    setTimeout(() => {
      const results = this.parlayEngine.runSyncSimulation(this.state.slateData, 10000);
      this.state.parlaySimResults = results;
      this.state.isParlaySimulating = false;
      this.renderBetSlip();
    }, 20);
  }

  renderParlaySlate() {
    const grid = document.getElementById('parlayMatchupGrid');
    const badge = document.getElementById('parlaySlateWeekBadge');
    if (!grid || !this.state.slateData) return;

    if (badge) badge.textContent = `WEEK ${this.state.activeWeek}`;

    const weekData = this.state.slateData.find(s => s.week === this.state.activeWeek);
    if (!weekData || !weekData.games || weekData.games.length === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);">No games scheduled for Week ${this.state.activeWeek}.</div>`;
      return;
    }

    const filter = this.state.parlayFilter || 'all';

    grid.innerHTML = weekData.games.map(g => {
      const homeSpread = Number(g.spread);
      const awaySpread = -homeSpread;
      const homeSpreadFormatted = homeSpread > 0 ? `+${homeSpread}` : `${homeSpread}`;
      const awaySpreadFormatted = awaySpread > 0 ? `+${awaySpread}` : `${awaySpread}`;
      const spreadOdds = g.spreadOdds ?? -110;

      const total = Number(g.total || 44.0);
      const overOdds = g.totalOverOdds ?? -110;
      const underOdds = g.totalUnderOdds ?? -110;

      const homeMl = g.homeMoneyline ?? -110;
      const awayMl = g.awayMoneyline ?? 110;

      // Leg Object definitions for interactive pill bindings
      const awaySpreadLeg = {
        id: `${g.id}_spread_${g.awayTeam}`,
        gameId: g.id,
        week: this.state.activeWeek,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        team: g.awayTeam,
        selection: g.awayTeam,
        marketType: 'spread',
        marketCategory: 'spread',
        lineValue: awaySpread,
        bookOdds: spreadOdds,
        label: `${g.awayTeam} ${awaySpreadFormatted}`,
        matchup: `${g.awayTeam} @ ${g.homeTeam}`
      };

      const homeSpreadLeg = {
        id: `${g.id}_spread_${g.homeTeam}`,
        gameId: g.id,
        week: this.state.activeWeek,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        team: g.homeTeam,
        selection: g.homeTeam,
        marketType: 'spread',
        marketCategory: 'spread',
        lineValue: homeSpread,
        bookOdds: spreadOdds,
        label: `${g.homeTeam} ${homeSpreadFormatted}`,
        matchup: `${g.awayTeam} @ ${g.homeTeam}`
      };

      const overLeg = {
        id: `${g.id}_total_over`,
        gameId: g.id,
        week: this.state.activeWeek,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        team: 'OVER',
        selection: 'OVER',
        marketType: 'total_over',
        marketCategory: 'total',
        lineValue: total,
        bookOdds: overOdds,
        label: `OVER ${total}`,
        matchup: `${g.awayTeam} @ ${g.homeTeam}`
      };

      const underLeg = {
        id: `${g.id}_total_under`,
        gameId: g.id,
        week: this.state.activeWeek,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        team: 'UNDER',
        selection: 'UNDER',
        marketType: 'total_under',
        marketCategory: 'total',
        lineValue: total,
        bookOdds: underOdds,
        label: `UNDER ${total}`,
        matchup: `${g.awayTeam} @ ${g.homeTeam}`
      };

      const awayMlLeg = {
        id: `${g.id}_ml_${g.awayTeam}`,
        gameId: g.id,
        week: this.state.activeWeek,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        team: g.awayTeam,
        selection: g.awayTeam,
        marketType: 'moneyline',
        marketCategory: 'moneyline',
        lineValue: null,
        bookOdds: awayMl,
        label: `${g.awayTeam} ML`,
        matchup: `${g.awayTeam} @ ${g.homeTeam}`
      };

      const homeMlLeg = {
        id: `${g.id}_ml_${g.homeTeam}`,
        gameId: g.id,
        week: this.state.activeWeek,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        team: g.homeTeam,
        selection: g.homeTeam,
        marketType: 'moneyline',
        marketCategory: 'moneyline',
        lineValue: null,
        bookOdds: homeMl,
        label: `${g.homeTeam} ML`,
        matchup: `${g.awayTeam} @ ${g.homeTeam}`
      };

      // Check active state for each pill
      const isAwaySpreadActive = this.parlayEngine.hasLeg(awaySpreadLeg.id);
      const isHomeSpreadActive = this.parlayEngine.hasLeg(homeSpreadLeg.id);
      const isOverActive = this.parlayEngine.hasLeg(overLeg.id);
      const isUnderActive = this.parlayEngine.hasLeg(underLeg.id);
      const isAwayMlActive = this.parlayEngine.hasLeg(awayMlLeg.id);
      const isHomeMlActive = this.parlayEngine.hasLeg(homeMlLeg.id);

      const encodeLeg = (obj) => encodeURIComponent(JSON.stringify(obj));

      return `
        <div class="parlay-card" data-game-id="${g.id}">
          
          <div class="parlay-card-header">
            <div class="parlay-teams-matchup">
              <span class="parlay-team-tag"><span class="team-dot"></span>${g.awayTeam}</span>
              <span style="color:var(--muted);font-weight:400;font-size:12px;">@</span>
              <span class="parlay-team-tag"><span class="team-dot" style="background:var(--cyan);"></span>${g.homeTeam}</span>
            </div>
            <div class="parlay-matchup-meta">
              <span class="parlay-meta-badge">O/U ${total}</span>
              <span class="parlay-meta-badge">${g.homeTeam} ${homeSpreadFormatted}</span>
            </div>
          </div>

          <div class="market-rows">
            
            <!-- Spread Market -->
            ${(filter === 'all' || filter === 'spread') ? `
              <div class="market-row-item">
                <div class="market-row-label">
                  <span>Point Spread</span>
                  <span>Spread Line</span>
                </div>
                <div class="market-pill-group">
                  <button class="market-pill ${isAwaySpreadActive ? 'selected' : ''}" onclick="toggleParlayLeg(JSON.parse(decodeURIComponent('${encodeLeg(awaySpreadLeg)}')))">
                    <span class="pill-team-line">
                      ${isAwaySpreadActive ? '<span class="pill-check">✓</span>' : ''}
                      <span>${g.awayTeam} ${awaySpreadFormatted}</span>
                    </span>
                    <span class="pill-odds">${this.parlayEngine.formatAmerican(spreadOdds)}</span>
                  </button>

                  <button class="market-pill ${isHomeSpreadActive ? 'selected' : ''}" onclick="toggleParlayLeg(JSON.parse(decodeURIComponent('${encodeLeg(homeSpreadLeg)}')))">
                    <span class="pill-team-line">
                      ${isHomeSpreadActive ? '<span class="pill-check">✓</span>' : ''}
                      <span>${g.homeTeam} ${homeSpreadFormatted}</span>
                    </span>
                    <span class="pill-odds">${this.parlayEngine.formatAmerican(spreadOdds)}</span>
                  </button>
                </div>
              </div>
            ` : ''}

            <!-- Total (Over / Under) Market -->
            ${(filter === 'all' || filter === 'total') ? `
              <div class="market-row-item">
                <div class="market-row-label">
                  <span>Game Total (O/U)</span>
                  <span>Line: ${total} Pts</span>
                </div>
                <div class="market-pill-group">
                  <button class="market-pill ${isOverActive ? 'selected' : ''}" onclick="toggleParlayLeg(JSON.parse(decodeURIComponent('${encodeLeg(overLeg)}')))">
                    <span class="pill-team-line">
                      ${isOverActive ? '<span class="pill-check">✓</span>' : ''}
                      <span>OVER ${total}</span>
                    </span>
                    <span class="pill-odds">${this.parlayEngine.formatAmerican(overOdds)}</span>
                  </button>

                  <button class="market-pill ${isUnderActive ? 'selected' : ''}" onclick="toggleParlayLeg(JSON.parse(decodeURIComponent('${encodeLeg(underLeg)}')))">
                    <span class="pill-team-line">
                      ${isUnderActive ? '<span class="pill-check">✓</span>' : ''}
                      <span>UNDER ${total}</span>
                    </span>
                    <span class="pill-odds">${this.parlayEngine.formatAmerican(underOdds)}</span>
                  </button>
                </div>
              </div>
            ` : ''}

            <!-- Moneyline Market -->
            ${(filter === 'all' || filter === 'moneyline') ? `
              <div class="market-row-item">
                <div class="market-row-label">
                  <span>Moneyline (Win Straight Up)</span>
                  <span>Vegas ML</span>
                </div>
                <div class="market-pill-group">
                  <button class="market-pill ${isAwayMlActive ? 'selected' : ''}" onclick="toggleParlayLeg(JSON.parse(decodeURIComponent('${encodeLeg(awayMlLeg)}')))">
                    <span class="pill-team-line">
                      ${isAwayMlActive ? '<span class="pill-check">✓</span>' : ''}
                      <span>${g.awayTeam} ML</span>
                    </span>
                    <span class="pill-odds">${this.parlayEngine.formatAmerican(awayMl)}</span>
                  </button>

                  <button class="market-pill ${isHomeMlActive ? 'selected' : ''}" onclick="toggleParlayLeg(JSON.parse(decodeURIComponent('${encodeLeg(homeMlLeg)}')))">
                    <span class="pill-team-line">
                      ${isHomeMlActive ? '<span class="pill-check">✓</span>' : ''}
                      <span>${g.homeTeam} ML</span>
                    </span>
                    <span class="pill-odds">${this.parlayEngine.formatAmerican(homeMl)}</span>
                  </button>
                </div>
              </div>
            ` : ''}

          </div>

        </div>
      `;
    }).join('');
  }

  onAutoBuildLegCountSelect(count) {
    this.state.autoBuildLegs = Math.max(2, Math.min(5, parseInt(count, 10) || 3));
    this.renderBetSlip();
  }

  onAutoBuildStrategySelect(strat) {
    this.state.autoBuildStrategy = (strat === 'high_win') ? 'high_win' : 'best_value';
    this.renderBetSlip();
  }

  onAutoBuildTicketCountSelect(count) {
    this.state.autoBuildTicketCount = Math.max(1, Math.min(3, parseInt(count, 10) || 1));
    this.renderBetSlip();
  }

  onSelectTicketTab(index) {
    const tickets = this.state.generatedTickets || [];
    const idx = parseInt(index, 10);
    if (!tickets[idx]) return;

    this.state.activeTicketIndex = idx;
    const ticket = tickets[idx];

    this.parlayEngine.clearSlip();
    (ticket.legs || []).forEach(leg => this.parlayEngine.addLeg(leg));
    this.state.parlaySimResults = ticket.simResults || null;
    this.state.autoBuildStrategyClassification = ticket.strategyClassification || null;

    this.renderParlaySlate();
    this.renderBetSlip();
  }

  toggleAutoBuildAccordion() {
    this.state.autoBuildAccordionOpen = !this.state.autoBuildAccordionOpen;
    this.renderBetSlip();
  }

  autoGenerateTicket() {
    const legsCount = this.state.autoBuildLegs || 3;
    const strategy = this.state.autoBuildStrategy || 'best_value';
    const ticketCount = this.state.autoBuildTicketCount || 1;

    // 1. Instant loading UI feedback (no main thread lockup)
    this.state.isAutoBuilding = true;
    this.renderBetSlip();

    // 2. Offload to Web Worker thread if active
    if (this.worker) {
      try {
        this.worker.postMessage({
          action: 'GENERATE_AUTO_TICKET',
          slateData: this.state.slateData,
          week: this.state.activeWeek,
          options: { legsCount, strategy, ticketCount }
        });
        return;
      } catch (e) {
        console.warn('Worker postMessage failed, falling back to sync:', e);
      }
    }

    // 3. Fallback: yield to UI thread so button renders loading state before simulation runs
    setTimeout(() => {
      this.runSyncAutoGenerateFallback(legsCount, strategy, ticketCount);
    }, 25);
  }

  runSyncAutoGenerateFallback(legsCount, strategy, ticketCount = 1) {
    try {
      const tickets = this.parlayEngine.generateAutoTickets(
        this.state.slateData,
        this.state.activeWeek,
        { legsCount, strategy, ticketCount }
      );

      if (!tickets || tickets.length === 0) {
        this.showToast(`⚠️ Could not auto-generate ticket for Week ${this.state.activeWeek}.`);
        this.state.isAutoBuilding = false;
        this.renderBetSlip();
        return;
      }

      this.state.generatedTickets = tickets;
      this.state.activeTicketIndex = 0;

      const activeTicket = tickets[0];
      this.parlayEngine.clearSlip();
      (activeTicket.legs || []).forEach(leg => {
        this.parlayEngine.addLeg(leg);
      });
      this.state.parlaySimResults = activeTicket.simResults || null;

      this.state.autoBuildAccordionOpen = false;
      this.state.isAutoBuilding = false;

      const stratName = activeTicket.strategyClassification || (strategy === 'high_win' ? 'High Win %' : 'Best Value (+EV)');
      this.state.autoBuildStrategyClassification = stratName;
      if (tickets.length > 1) {
        this.showToast(`⚡ Auto-Generated ${tickets.length} Distinct Tickets (${stratName})! 🎯`);
      } else {
        this.showToast(`⚡ Auto-Generated ${activeTicket.legs.length}-Leg Ticket (${stratName})! 🎯`);
      }

      this.renderParlaySlate();
      this.renderBetSlip();
    } catch (err) {
      console.error('Sync auto-generate fallback error:', err);
      this.state.isAutoBuilding = false;
      this.renderBetSlip();
      this.showToast(`⚠️ Error auto-generating ticket.`);
    }
  }

  renderBetSlip() {
    const legs = this.parlayEngine.legs;
    const legCountBadge = document.getElementById('slipLegCountBadge');
    const mobileCountBadge = document.getElementById('mobileSlipCountBadge');
    const mobileSlipToggle = document.getElementById('mobileSlipToggle');
    const banner = document.getElementById('slipTicketTypeBanner');
    const accordionEl = document.getElementById('slipAutoBuildAccordion');
    const legsContainer = document.getElementById('slipLegsList');
    const oddsCard = document.getElementById('slipOddsCard');
    const analyticsCard = document.getElementById('slipAnalyticsCard');

    const legsCount = this.state.autoBuildLegs || 3;
    const strategy = this.state.autoBuildStrategy || 'best_value';
    const ticketCount = this.state.autoBuildTicketCount || 1;
    const isAccordionOpen = this.state.autoBuildAccordionOpen || false;

    // Update Counts
    const countText = `${legs.length} ${legs.length === 1 ? 'Leg Selected' : 'Legs Selected'}`;
    if (legCountBadge) legCountBadge.textContent = countText;
    if (mobileCountBadge) mobileCountBadge.textContent = String(legs.length);
    if (mobileSlipToggle) mobileSlipToggle.style.display = legs.length > 0 ? 'inline-flex' : 'none';

    // Batch Multi-Ticket Tabs (v3.9.0)
    const tabsContainer = document.getElementById('slipTicketTabs');
    if (tabsContainer) {
      const tickets = this.state.generatedTickets || [];
      if (tickets.length >= 2 && legs.length > 0) {
        tabsContainer.style.display = 'flex';
        tabsContainer.innerHTML = tickets.map((t, idx) => {
          const isActive = idx === this.state.activeTicketIndex;
          const oddsDisplay = t.formattedOdds || (t.combinedOdds > 0 ? `+${t.combinedOdds}` : `${t.combinedOdds}`);
          return `
            <button class="slip-ticket-tab ${isActive ? 'active' : ''}" onclick="onSelectTicketTab(${idx})" title="Switch to Ticket ${idx + 1}">
              <span class="ticket-tab-title">Ticket ${idx + 1}</span>
              <span class="ticket-tab-odds">${oddsDisplay}</span>
            </button>
          `;
        }).join('');
      } else {
        tabsContainer.style.display = 'none';
        tabsContainer.innerHTML = '';
      }
    }

    // Update Ticket Type Classification Banner
    const classification = this.parlayEngine.getTicketClassification();
    if (banner) {
      const activeGenTicket = this.state.generatedTickets && this.state.generatedTickets[this.state.activeTicketIndex];
      const isVigMinimized = activeGenTicket && activeGenTicket.strategyClassification === 'Best Available (Vig-Minimized)';
      const badgeClass = isVigMinimized ? 'badge-fair-price' : classification.badgeClass;
      const badgeLabel = isVigMinimized ? 'Best Available (Vig-Minimized)' : classification.label;
      const badgeDesc = isVigMinimized
        ? 'Slate has no +EV combinations. Selected best available lines to minimize bookmaker vig.'
        : (classification.desc || 'Click any betting pill to build your ticket.');
      const badgeStyle = isVigMinimized ? 'style="background: rgba(255,184,0,0.15); color: var(--gold-bright); border: 1px solid var(--gold-bright);"' : '';

      banner.innerHTML = `
        <div class="ticket-badge ${badgeClass}" ${badgeStyle}>${badgeLabel}</div>
        <div class="ticket-badge-desc">${badgeDesc}</div>
      `;
    }

    // Top Compact Accordion (When populated with >= 1 leg)
    if (accordionEl) {
      if (legs.length === 0) {
        accordionEl.style.display = 'none';
        accordionEl.innerHTML = '';
      } else {
        accordionEl.style.display = 'block';
        accordionEl.innerHTML = `
          <div class="quick-build-accordion ${isAccordionOpen ? 'open' : ''}">
            <button class="accordion-toggle-btn" onclick="toggleAutoBuildAccordion()">
              <span class="accordion-toggle-left">⚡ Quick Auto-Build</span>
              <span class="accordion-toggle-arrow">${isAccordionOpen ? '▲' : '▼'}</span>
            </button>
            ${isAccordionOpen ? `
              <div class="accordion-body">
                <div class="quick-build-section">
                  <div class="quick-build-label">Ticket Size (Legs)</div>
                  <div class="quick-build-pills">
                    <button class="quick-pill ${legsCount === 2 ? 'active' : ''}" onclick="onAutoBuildLegCountSelect(2)">2</button>
                    <button class="quick-pill ${legsCount === 3 ? 'active' : ''}" onclick="onAutoBuildLegCountSelect(3)">3</button>
                    <button class="quick-pill ${legsCount === 4 ? 'active' : ''}" onclick="onAutoBuildLegCountSelect(4)">4</button>
                    <button class="quick-pill ${legsCount === 5 ? 'active' : ''}" onclick="onAutoBuildLegCountSelect(5)">5</button>
                  </div>
                </div>
                <div class="quick-build-section">
                  <div class="quick-build-label">Optimization Strategy</div>
                  <div class="quick-build-strategies compact">
                    <button class="strat-pill ${strategy === 'high_win' ? 'active' : ''}" onclick="onAutoBuildStrategySelect('high_win')">
                      <span class="strat-pill-title">🛡️ High Win %</span>
                    </button>
                    <button class="strat-pill ${strategy === 'best_value' ? 'active' : ''}" onclick="onAutoBuildStrategySelect('best_value')">
                      <span class="strat-pill-title">⚡ Best Value (+EV)</span>
                    </button>
                  </div>
                </div>
                <div class="quick-build-section">
                  <div class="quick-build-label">Tickets to Build</div>
                  <div class="quick-build-pills tickets-count">
                    <button class="quick-pill ${ticketCount === 1 ? 'active' : ''}" onclick="onAutoBuildTicketCountSelect(1)">1</button>
                    <button class="quick-pill ${ticketCount === 2 ? 'active' : ''}" onclick="onAutoBuildTicketCountSelect(2)">2</button>
                    <button class="quick-pill ${ticketCount === 3 ? 'active' : ''}" onclick="onAutoBuildTicketCountSelect(3)">3</button>
                  </div>
                </div>
                <button class="btn-auto-build ${this.state.isAutoBuilding ? 'loading' : ''}" onclick="autoGenerateTicket()" ${this.state.isAutoBuilding ? 'disabled' : ''} style="margin-top:8px;">
                  <span>${this.state.isAutoBuilding ? '⚡ Calculating 10k Monte Carlo...' : (ticketCount > 1 ? `⚡ Auto-Generate ${ticketCount} Tickets` : '⚡ Auto-Generate New Ticket')}</span>
                </button>
              </div>
            ` : ''}
          </div>
        `;
      }
    }

    // Render Itemized Leg List or Empty State Quick Build Widget
    if (legsContainer) {
      if (legs.length === 0) {
        legsContainer.innerHTML = `
          <div class="quick-build-widget">
            <div class="quick-build-header">
              <div class="quick-build-title">
                <span>⚡ Quick Build Ticket</span>
              </div>
              <div class="quick-build-sub">Instant algorithmic parlay generator</div>
            </div>

            <div class="quick-build-section">
              <div class="quick-build-label">Ticket Size (Legs)</div>
              <div class="quick-build-pills">
                <button class="quick-pill ${legsCount === 2 ? 'active' : ''}" onclick="onAutoBuildLegCountSelect(2)">2</button>
                <button class="quick-pill ${legsCount === 3 ? 'active' : ''}" onclick="onAutoBuildLegCountSelect(3)">3</button>
                <button class="quick-pill ${legsCount === 4 ? 'active' : ''}" onclick="onAutoBuildLegCountSelect(4)">4</button>
                <button class="quick-pill ${legsCount === 5 ? 'active' : ''}" onclick="onAutoBuildLegCountSelect(5)">5</button>
              </div>
            </div>

            <div class="quick-build-section">
              <div class="quick-build-label">Optimization Strategy</div>
              <div class="quick-build-strategies">
                <button class="strat-pill ${strategy === 'high_win' ? 'active' : ''}" onclick="onAutoBuildStrategySelect('high_win')">
                  <span class="strat-pill-title">🛡️ High Win %</span>
                  <span class="strat-pill-desc">Favorites & strong MLs</span>
                </button>
                <button class="strat-pill ${strategy === 'best_value' ? 'active' : ''}" onclick="onAutoBuildStrategySelect('best_value')">
                  <span class="strat-pill-title">⚡ Best Value (+EV)</span>
                  <span class="strat-pill-desc">Correlated SGP & low vig</span>
                </button>
              </div>
            </div>

            <div class="quick-build-section">
              <div class="quick-build-label">Tickets to Build</div>
              <div class="quick-build-pills tickets-count">
                <button class="quick-pill ${ticketCount === 1 ? 'active' : ''}" onclick="onAutoBuildTicketCountSelect(1)">1</button>
                <button class="quick-pill ${ticketCount === 2 ? 'active' : ''}" onclick="onAutoBuildTicketCountSelect(2)">2</button>
                <button class="quick-pill ${ticketCount === 3 ? 'active' : ''}" onclick="onAutoBuildTicketCountSelect(3)">3</button>
              </div>
            </div>

            <button class="btn-auto-build ${this.state.isAutoBuilding ? 'loading' : ''}" onclick="autoGenerateTicket()" ${this.state.isAutoBuilding ? 'disabled' : ''}>
              <span>${this.state.isAutoBuilding ? '⚡ Calculating 10k Monte Carlo...' : (ticketCount > 1 ? `⚡ Auto-Generate ${ticketCount} Tickets` : '⚡ Auto-Generate Ticket')}</span>
            </button>

            <div class="quick-build-hint">
              <span>💡 Or select any spread, total, or ML pill from the matchups to build manually.</span>
            </div>
          </div>
        `;
      } else {
        legsContainer.innerHTML = legs.map(leg => {
          let marketTag = 'SPREAD';
          if (leg.marketCategory === 'total') marketTag = 'TOTAL';
          if (leg.marketCategory === 'moneyline') marketTag = 'MONEYLINE';

          return `
            <div class="slip-leg-item">
              <div class="slip-leg-info">
                <div class="slip-leg-title">
                  <span>${leg.label}</span>
                  <span class="slip-leg-market-tag">${marketTag}</span>
                </div>
                <div class="slip-leg-matchup">${leg.matchup} • Week ${leg.week}</div>
              </div>
              <div class="slip-leg-right">
                <span class="slip-leg-odds">${this.parlayEngine.formatAmerican(leg.bookOdds)}</span>
                <button class="btn-remove-leg" onclick="removeParlayLeg('${leg.id}')" title="Remove selection">✕</button>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // Show or hide odds card and analytics card
    if (legs.length === 0) {
      if (oddsCard) oddsCard.style.display = 'none';
      if (analyticsCard) analyticsCard.style.display = 'none';
      return;
    }

    if (oddsCard) oddsCard.style.display = 'block';
    if (analyticsCard) analyticsCard.style.display = 'flex';

    // Compute quantitative analytics
    const analytics = this.parlayEngine.calculateAnalytics(
      this.state.parlaySimResults,
      this.state.slateData,
      this.parlayEngine.customOfferedOdds,
      this.parlayEngine.stake
    );

    const activeGenTicket = this.state.generatedTickets && this.state.generatedTickets[this.state.activeTicketIndex];
    if (activeGenTicket && activeGenTicket.strategyClassification === 'Best Available (Vig-Minimized)') {
      analytics.ticketValue.badge = 'Best Available (Vig-Minimized)';
      analytics.ticketValue.badgeClass = 'badge-fair-price';
      analytics.ticketValue.color = 'var(--gold-bright)';
      analytics.ticketValue.subtitle = `Vig minimized (${analytics.vigTaxPct.toFixed(1)}% bookmaker margin)`;
    }

    // Update Stake and Odds Inputs
    const stakeInput = document.getElementById('slipStakeInput');
    if (stakeInput && document.activeElement !== stakeInput) {
      stakeInput.value = analytics.stake;
    }

    const oddsInput = document.getElementById('slipOfferedOddsInput');
    const resetOddsBtn = document.getElementById('slipResetOddsBtn');
    if (oddsInput && document.activeElement !== oddsInput) {
      oddsInput.value = this.parlayEngine.formatAmerican(analytics.effectiveAmericanOdds);
    }
    if (resetOddsBtn) {
      resetOddsBtn.style.display = analytics.isCustomOdds ? 'inline' : 'none';
    }

    // Update Analytics Card Elements
    const winProbEl = document.getElementById('slipSimWinProb');
    const fairOddsSubEl = document.getElementById('slipFairOddsSub');
    const evBadgeEl = document.getElementById('slipEvBadge');
    const vigSubEl = document.getElementById('slipVigSub');
    const boostValEl = document.getElementById('slipCorrelationBoostVal');
    const boostDescEl = document.getElementById('slipCorrelationExplanation');
    const totalPayoutEl = document.getElementById('slipTotalPayoutVal');
    const totalProfitEl = document.getElementById('slipTotalProfitVal');
    const simStatusBadge = document.getElementById('slipSimStatusBadge');

    if (simStatusBadge) {
      simStatusBadge.textContent = this.state.isParlaySimulating ? '⚡ Simulating 10k...' : '10k Monte Carlo';
    }

    if (winProbEl) winProbEl.textContent = `${analytics.simWinProbPct}%`;
    if (fairOddsSubEl) {
      if (analytics.pushProbabilityPct > 0) {
        fairOddsSubEl.textContent = `Fair True Odds: ${this.parlayEngine.formatAmerican(analytics.fairAmericanOdds)} • ${analytics.pushProbabilityPct}% Push Prob`;
      } else {
        fairOddsSubEl.textContent = `Fair True Odds: ${this.parlayEngine.formatAmerican(analytics.fairAmericanOdds)}`;
      }
    }

    // 1. Ticket Value (Plain-English)
    if (evBadgeEl) {
      evBadgeEl.textContent = analytics.ticketValue.badge;
      evBadgeEl.style.color = analytics.ticketValue.color;
      evBadgeEl.style.fontSize = '14px';
    }

    if (vigSubEl) {
      if (activeGenTicket && activeGenTicket.strategyClassification === 'Best Available (Vig-Minimized)') {
        vigSubEl.textContent = analytics.ticketValue.subtitle;
      } else if (analytics.exactSimulatedEvPct !== null && analytics.hasFlatLines) {
        vigSubEl.textContent = `${analytics.ticketValue.subtitle} • Push-Adjusted EV: ${analytics.exactSimulatedEvPct > 0 ? '+' : ''}${analytics.exactSimulatedEvPct}%`;
      } else {
        vigSubEl.textContent = analytics.ticketValue.subtitle;
      }
    }

    // 2. Pick Synergy (Plain-English)
    if (boostValEl) {
      const boost = analytics.correlationBoostPct;
      if (analytics.classification.isSgp) {
        if (boost > 0.5) {
          boostValEl.textContent = `+${boost.toFixed(1)}%`;
          boostValEl.style.color = 'var(--gold-bright)';
        } else if (boost < -0.5) {
          boostValEl.textContent = `${boost.toFixed(1)}%`;
          boostValEl.style.color = 'var(--danger)';
        } else {
          boostValEl.textContent = '0.0%';
          boostValEl.style.color = 'var(--text-dim)';
        }
      } else {
        boostValEl.textContent = 'Neutral';
        boostValEl.style.color = 'var(--text-dim)';
      }
    }

    if (boostDescEl) {
      boostDescEl.textContent = analytics.pickSynergy.text;
    }

    if (totalPayoutEl) totalPayoutEl.textContent = `$${analytics.potentialPayout.toFixed(2)}`;
    if (totalProfitEl) totalProfitEl.textContent = `+$${analytics.potentialProfit.toFixed(2)}`;
  }

  toggleMobileBetSlip(isOpen) {
    const drawer = document.getElementById('betSlipDrawer');
    if (drawer) {
      drawer.classList.toggle('mobile-open', isOpen);
    }
  }

  copyParlayTicket() {
    if (this.parlayEngine.legs.length === 0) return;

    const analytics = this.parlayEngine.calculateAnalytics(
      this.state.parlaySimResults,
      this.state.slateData,
      this.parlayEngine.customOfferedOdds,
      this.parlayEngine.stake
    );

    let text = `🐾 SCOUT BOWIE TICKET BREAKDOWN\n`;
    text += `Type: ${analytics.classification.label}\n`;
    text += `Stake: $${analytics.stake} ➔ Potential Payout: $${analytics.potentialPayout.toFixed(2)} (+$${analytics.potentialProfit.toFixed(2)} Profit)\n`;
    text += `Book Offered Odds: ${this.parlayEngine.formatAmerican(analytics.effectiveAmericanOdds)}\n`;
    text += `True Win Chance: ${analytics.simWinProbPct}% (Fair Odds: ${this.parlayEngine.formatAmerican(analytics.fairAmericanOdds)})\n`;
    text += `Ticket Value: ${analytics.ticketValue.badge} (${analytics.ticketValue.subtitle})\n`;
    text += `Pick Synergy: ${analytics.pickSynergy.text}\n\n`;
    text += `SELECTED LEGS (${analytics.legsCount}):\n`;

    this.parlayEngine.legs.forEach((l, idx) => {
      text += ` ${idx + 1}. [${l.marketCategory.toUpperCase()}] ${l.label} (${this.parlayEngine.formatAmerican(l.bookOdds)}) - ${l.matchup}\n`;
    });

    text += `\nEngine: 10,000-Sim Breakdown via Scout Bowie Analytics Suite`;

    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast('📋 Copied Bet Slip & Ticket Breakdown to clipboard! 🐾');
      }).catch(() => {
        this.showToast('Copied bet slip to clipboard!');
      });
    }
  }

  // ==========================================
  // UTILITIES & EXPORTERS
  // ==========================================

  copySurvivorPath() {
    if (!this.state.currentPathResult) return;
    const text = this.engine.formatClipboardSurvivorPath(this.state.currentPathResult, {
      poolSize: this.state.poolSize
    });

    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast('📋 Copied Optimal Survivor Path to clipboard! 🐾');
      }).catch(() => {
        this.showToast('Copied path to clipboard!');
      });
    }
  }

  copyPickemSheet() {
    if (!this.state.pickemConfidence) return;
    const isATS = this.state.pickemMode === 'ats';
    const text = this.engine.formatClipboardPickem(this.state.pickemConfidence, this.state.activeWeek, this.state.pickemMode);

    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast(`📋 Copied Week ${this.state.activeWeek} ${isATS ? 'ATS' : 'SU'} Pick'em Sheet to clipboard! 🐾`);
      }).catch(() => {
        this.showToast('Copied pick\'em sheet to clipboard!');
      });
    }
  }

  triggerBowieEasterEgg(el) {
    if (el) {
      el.style.transform = 'scale(1.3) rotate(360deg)';
      setTimeout(() => { el.style.transform = ''; }, 600);
    }
    const barkQuotes = [
      "Woof! Math never lies — always fade the consensus trap!",
      "10,000 simulations completed in milliseconds. Golden bones for all!",
      "Survivor is a game of survival AND leverage. Play to win the whole pool!",
      "Bark! SGP correlation is the secret to capturing positive expected value!"
    ];
    const q = barkQuotes[Math.floor(Math.random() * barkQuotes.length)];
    this.showToast(q);
  }

  showToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => { toast.classList.remove('show'); }, 3000);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.oddsApp = new OddsSuiteApp();
});

export { OddsSuiteApp };
