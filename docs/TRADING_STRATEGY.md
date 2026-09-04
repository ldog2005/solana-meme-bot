# Trading Strategy — RESEARCH BASELINE (strategy_v0.1)

This is a starting hypothesis, not a proven edge. It exists to be measured and revised through
paper trading and replay. Every parameter is a setting; changing entry/exit settings creates a new
strategy version so results are comparable.

## Universe
Solana tokens seen on DexScreener feeds with SOL/USDC quote, age 20 min – 3 days, liquidity ≥ $25k,
1h volume ≥ $15k, ≥ 150 trades/h. Rationale: the first ~20 minutes are dominated by snipers and
bundled buys (see RESEARCH.md); after 3 days the "fresh market" dynamics we model have decayed.

## Mandatory gates (any failure → no entry, ever)
Safety gate passed · liquidity/volume/activity minimums · age window · top-10 ≤ 35 %, single ≤ 10 %,
creator ≤ 5 %, LP locked ≥ 80 % · data age ≤ 90 s · not blacklisted · no open position / cooldown ·
portfolio limits (positions, exposure, daily/weekly loss) · regime not EXTREMELY_RISKY ·
emergency stop inactive.

## Entry quality (failure → WATCH, re-evaluated each scan)
Score ≥ 70 (78 in WEAK regime) · not OVEREXTENDED (1h > +120 % or 5m > +25 %) · not
DETERIORATING · buy/sell ratio 1h ≥ 1.05 · 5-minute volume pace ≥ 50 % of 1h rate · 5m move ≤ +12 %.

## Scoring weights and why
| Component | Pts | Why |
|---|---|---|
| Safety | 30 | Dominant loss mode is total loss (rug/freeze/mint), not adverse price. |
| Liquidity | 15 | Determines whether exits are executable at modelled slippage. |
| Market structure | 15 | Prefer constructive trends over vertical spikes; entries after consolidation. |
| Holders | 10 | Concentration = someone else controls the price. |
| Momentum | 10 | Useful but trivially manufactured; deliberately low. |
| Volume quality | 10 | Average trade size and turnover vs liquidity flag wash trading. |
| Participants | 5 | No reliable free smart-money feed identified; neutral baseline. |
| Context | 5 | Regime from SOL trend + aggregate activity. |

## Exits (defaults)
Hard stop −20 % · TP1 +30 % sell 25 % · TP2 +60 % sell 25 % · TP3 +100 % sell 25 % · trailing 20 %
armed at +20 % · max hold 4 h · emergency: liquidity −40 %, 5m price −35 %, new critical flag.

## Experiment log
Record each experiment on the Performance page (results are never overwritten). Suggested first
experiments: MIN_LIQUIDITY 25k vs 60k; MIN_SCORE 70 vs 78; trailing 20 % vs 30 %; MIN_TOKEN_AGE 20
vs 60 min. Judge by expectancy, profit factor, drawdown and out-of-sample stability — not win rate,
and not on fewer than 30 trades.
