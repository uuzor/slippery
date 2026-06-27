'use client';

import { useEffect, useMemo, useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';

import {
  previewConstants,
  previewSlipFromQuotes,
  MIN_EXECUTION_WINDOW_MS,
  useActiveSlips,
  useOracleSettlements,
  useOwnedQuoteCoins,
  useOwnedSlipReceipts,
  usePendingSlips,
  usePredictMarkets,
  usePredictSelectionQuote,
  useProtocolWrites,
  useVaultState,
  type MarketLeg,
  type PredictMarket,
  type PredictQuote,
  type SlipReceipt,
} from '../lib/protocol';
import styles from './TradeClient.module.css';

const PRICE_SCALE = 1_000_000_000n;

function shortId(value: string): string {
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatDusdc(value: bigint, digits = 2): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').slice(0, digits);
  return digits === 0 ? whole.toLocaleString() : `${whole.toLocaleString()}.${fraction}`;
}

function formatUsdPrice(value: bigint): string {
  const whole = value / 1_000_000_000n;
  const cents = ((value % 1_000_000_000n) / 10_000_000n).toString().padStart(2, '0');
  return `$${whole.toLocaleString()}.${cents}`;
}

function formatOdds(value: bigint): string {
  if (value === 0n) return '--';
  const whole = value / PRICE_SCALE;
  const fraction = ((value % PRICE_SCALE) / 10_000_000n).toString().padStart(2, '0');
  return `${whole}.${fraction}x`;
}

function formatPercentBps(value: bigint): string {
  const sign = value > 0n ? '+' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${value < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}%`;
}

function countdown(expiry: bigint, now: number): string {
  const delta = Number(expiry) - now;
  if (delta <= 0) return 'Expired';
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return `${hours}h ${remainder}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function expiryClock(expiry: bigint): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(Number(expiry)));
}

function legKey(leg: Pick<MarketLeg, 'oracleId' | 'strike' | 'isUp'>): string {
  return `${leg.oracleId}:${leg.strike}:${leg.isUp ? 'up' : 'down'}`;
}

function quantityFromInput(value: string): bigint | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const quantity = BigInt(value);
  return quantity > 0n ? quantity : null;
}

function contractLabel(leg: Pick<MarketLeg, 'strike' | 'isUp'>, asset = 'BTC'): string {
  return `${asset} ${leg.isUp ? 'above' : 'at or below'} ${formatUsdPrice(leg.strike)}`;
}

type LegViewState = 'pending' | 'live' | 'won' | 'lost' | 'awaiting';

function resolvedLegState(
  leg: MarketLeg,
  settlementPrice: bigint | null | undefined,
  isPending: boolean,
  isActive: boolean,
  now: number,
): LegViewState {
  if (isPending) return 'pending';
  if (settlementPrice !== null && settlementPrice !== undefined) {
    const won = leg.isUp ? settlementPrice > leg.strike : settlementPrice <= leg.strike;
    return won ? 'won' : 'lost';
  }
  if (isActive && Number(leg.expiry) > now) return 'live';
  return Number(leg.expiry) <= now ? 'awaiting' : 'live';
}

function receiptStatus(states: LegViewState[], pending: boolean, active: boolean) {
  if (pending) return { label: 'Pending execution', className: styles.statusPending };
  if (active && states.some((state) => state === 'live')) {
    return { label: 'Live', className: styles.statusLive };
  }
  if (states.length > 0 && states.every((state) => state === 'won')) {
    return { label: 'Won', className: styles.statusWon };
  }
  if (states.some((state) => state === 'lost')) {
    return { label: 'Lost', className: styles.statusLost };
  }
  return { label: 'Resolving', className: styles.statusPending };
}

function marketDelta(market: PredictMarket): bigint {
  if (market.spot === 0n) return 0n;
  return ((market.forward - market.spot) * 10_000n) / market.spot;
}

export default function TradeClient() {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const [now, setNow] = useState(() => Date.now());
  const [quantityInput, setQuantityInput] = useState('1000000');
  const [selectedLegs, setSelectedLegs] = useState<PredictQuote[]>([]);
  const [busyLeg, setBusyLeg] = useState<string | null>(null);
  const [isPlacing, setIsPlacing] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const { data: markets, isLoading, error: marketsError, refresh } = usePredictMarkets('BTC', 8, 3, 0);
  const { data: quoteCoins, refresh: refreshCoins } = useOwnedQuoteCoins(address, 45_000);
  const { data: receipts, refresh: refreshReceipts } = useOwnedSlipReceipts(address, 45_000);
  const { data: pendingSlips, refresh: refreshPending } = usePendingSlips(45_000);
  const { data: activeSlips, refresh: refreshActive } = useActiveSlips(45_000);
  const { data: vault, refresh: refreshVault } = useVaultState(45_000);
  const oracleIds = useMemo(
    () => [...new Set((receipts ?? []).flatMap((receipt) => receipt.legs.map((leg) => leg.oracleId)))],
    [receipts],
  );
  const { data: settlements } = useOracleSettlements(oracleIds, 30_000);
  const { quoteFromMarket, isLoading: isQuoting, error: quoteError } = usePredictSelectionQuote();
  const { placeSlip, cancelPendingSlip } = useProtocolWrites();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const quantity = quantityFromInput(quantityInput);
  const preview = previewSlipFromQuotes(selectedLegs);
  const balance = (quoteCoins ?? []).reduce((sum, coin) => sum + coin.balance, 0n);
  const selectedKeys = new Set(selectedLegs.map(legKey));
  const pendingIds = new Set((pendingSlips ?? []).map((slip) => slip.slipId));
  const activeIds = new Set((activeSlips ?? []).map((slip) => slip.slipId));
  const settlementMap = new Map((settlements ?? []).map((item) => [item.oracleId, item.settlementPrice]));
  const canPlace = Boolean(
    address
    && selectedLegs.length >= Number(previewConstants.minLegs)
    && preview.requiredStake > 0n
    && preview.requiredStake <= balance
    && !isPlacing,
  );

  async function addLeg(market: PredictMarket, strike: bigint, isUp: boolean) {
    setMessage(null);
    if (!quantity) {
      setMessage({ kind: 'error', text: 'Enter a valid position quantity first.' });
      return;
    }
    const key = legKey({ oracleId: market.oracleId, strike, isUp });
    if (!selectedKeys.has(key) && selectedLegs.length >= Number(previewConstants.maxLegs)) {
      setMessage({ kind: 'error', text: `A slip can contain at most ${previewConstants.maxLegs} legs.` });
      return;
    }

    setBusyLeg(key);
    try {
      const quote = await quoteFromMarket({ market, strike, isUp, quantity, sender: address ?? undefined });
      setSelectedLegs((current) => [...current.filter((leg) => legKey(leg) !== key), quote]);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyLeg(null);
    }
  }

  async function submitSlip() {
    setMessage(null);
    if (!address || !quoteCoins?.length) {
      setMessage({ kind: 'error', text: 'Connect a funded wallet before placing this slip.' });
      return;
    }
    const executionCutoff = BigInt(Date.now()) + MIN_EXECUTION_WINDOW_MS;
    if (selectedLegs.some((leg) => leg.expiry <= executionCutoff)) {
      setMessage({
        kind: 'error',
        text: 'One or more legs are too close to expiry. Remove them and select a later market.',
      });
      return;
    }
    setIsPlacing(true);
    try {
      const result = await placeSlip({
        coinObjectIds: quoteCoins.map((coin) => coin.coinObjectId),
        stakeAmount: preview.requiredStake,
        legs: selectedLegs,
      });
      setSelectedLegs([]);
      setMessage({ kind: 'success', text: `Slip submitted: ${result.digest}` });
      await Promise.all([refreshCoins(), refreshReceipts(), refreshPending(), refreshActive(), refreshVault()]);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsPlacing(false);
    }
  }

  async function cancelSlip(receiptId: string) {
    setMessage(null);
    setCancelId(receiptId);
    try {
      const result = await cancelPendingSlip({ slipId: receiptId });
      setMessage({ kind: 'success', text: `Pending slip cancelled: ${result.digest}` });
      await Promise.all([refreshCoins(), refreshReceipts(), refreshPending(), refreshVault()]);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCancelId(null);
    }
  }

  const referenceMarket = markets?.[0];

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.ticker}>
          <div className={styles.tickerLead}>
            <div className={styles.eyebrow}>DeepBook Predict / BTC</div>
            <div className={styles.tickerTitle}>Build a multi-expiry BTC view</div>
          </div>
          <div className={styles.tickerStat}>
            <span className={styles.label}>BTC spot</span>
            <strong className={styles.tickerValue}>{referenceMarket ? formatUsdPrice(referenceMarket.spot) : '--'}</strong>
          </div>
          <div className={styles.tickerStat}>
            <span className={styles.label}>Next expiry</span>
            <strong className={styles.tickerValue}>{referenceMarket ? countdown(referenceMarket.expiry, now) : '--'}</strong>
          </div>
          <div className={styles.tickerStat}>
            <span className={styles.label}>Wallet</span>
            <strong className={styles.tickerValue}>{formatDusdc(balance)} DUSDC</strong>
          </div>
          <div className={styles.tickerStat}>
            <span className={styles.label}>Bonus liquidity</span>
            <strong className={styles.tickerValue}>{vault ? `${formatDusdc(vault.availableBonusCapacity)} DUSDC` : '--'}</strong>
          </div>
        </section>

        <div className={styles.workspace}>
          <section className={styles.board}>
            <header className={styles.boardHeader}>
              <div>
                <h1 className={styles.boardTitle}>BTC options board</h1>
                <p className={styles.boardSubline}>Choose a direction, strike, and expiry. Each selection becomes one parlay leg.</p>
              </div>
              <button className={styles.refresh} onClick={() => void refresh()}>Refresh book</button>
            </header>

            {marketsError ? (
              <div className={styles.boardError}>
                Markets could not load. {marketsError}
                <button className={styles.refresh} onClick={() => void refresh()}> Retry</button>
              </div>
            ) : null}
            {isLoading && !markets?.length ? <div className={styles.skeleton}>Loading live BTC expiries...</div> : null}

            {(markets ?? []).map((market) => {
              const delta = marketDelta(market);
              return (
                <article className={styles.marketGroup} key={market.marketId}>
                  <div className={styles.marketHeading}>
                    <div className={styles.marketIdentity}>
                      <div className={styles.marketName}>BTC in {countdown(market.expiry, now)}</div>
                      <div className={styles.marketPrompt}>Resolves {expiryClock(market.expiry)} against DeepBook oracle {shortId(market.oracleId)}</div>
                    </div>
                    <div className={styles.marketMetric}>
                      <span className={styles.label}>Spot</span>
                      <strong>{formatUsdPrice(market.spot)}</strong>
                    </div>
                    <div className={styles.marketMetric}>
                      <span className={styles.label}>Forward</span>
                      <strong>{formatUsdPrice(market.forward)}</strong>
                    </div>
                    <div className={styles.marketMetric}>
                      <span className={styles.label}>Forward delta</span>
                      <strong className={delta >= 0n ? styles.deltaPositive : styles.deltaNegative}>{formatPercentBps(delta)}</strong>
                    </div>
                  </div>

                  <div className={styles.tableHead}>
                    <span>Contract</span>
                    <span>From spot</span>
                    <span>Above strike</span>
                    <span>At or below strike</span>
                  </div>

                  {market.strikeOptions.map((option) => {
                    const distanceBps = market.spot === 0n ? 0n : ((option.strike - market.spot) * 10_000n) / market.spot;
                    const upKey = legKey({ oracleId: market.oracleId, strike: option.strike, isUp: true });
                    const downKey = legKey({ oracleId: market.oracleId, strike: option.strike, isUp: false });
                    const upSelected = selectedKeys.has(upKey);
                    const downSelected = selectedKeys.has(downKey);
                    const upQuote = selectedLegs.find((leg) => legKey(leg) === upKey);
                    const downQuote = selectedLegs.find((leg) => legKey(leg) === downKey);
                    return (
                      <div className={styles.contractRow} key={`${market.marketId}:${option.strike}`}>
                        <div className={styles.contractIdentity}>
                          <div className={styles.contractTitle}>BTC settles around {formatUsdPrice(option.strike)}</div>
                          <div className={styles.contractDetail}>
                            {option.isAtTheMoney ? 'Closest listed strike' : `${option.distanceFromAtmSteps} strike step${option.distanceFromAtmSteps === 1n ? '' : 's'} from ATM`}
                          </div>
                        </div>
                        <div className={styles.distance}>
                          <span className={distanceBps >= 0n ? styles.deltaPositive : styles.deltaNegative}>{formatPercentBps(distanceBps)}</span>
                          <div className={styles.contractDetail}>vs live spot</div>
                        </div>
                        <button
                          className={`${styles.outcomeButton} ${upSelected ? styles.outcomeSelected : ''}`}
                          disabled={!quantity || busyLeg === upKey || busyLeg === downKey}
                          onClick={() => void addLeg(market, option.strike, true)}
                        >
                          <span className={styles.outcomeSide}><span>BTC ABOVE</span><span>{upSelected ? 'Selected' : '+'}</span></span>
                          <span className={styles.outcomeCost}>
                            {busyLeg === upKey && isQuoting ? 'Getting live quote...' : upQuote ? `${formatDusdc(upQuote.quoteAmount)} DUSDC` : `in ${countdown(market.expiry, now)}`}
                          </span>
                        </button>
                        <button
                          className={`${styles.outcomeButton} ${downSelected ? styles.outcomeSelected : ''}`}
                          disabled={!quantity || busyLeg === upKey || busyLeg === downKey}
                          onClick={() => void addLeg(market, option.strike, false)}
                        >
                          <span className={styles.outcomeSide}><span>BTC BELOW</span><span>{downSelected ? 'Selected' : '+'}</span></span>
                          <span className={styles.outcomeCost}>
                            {busyLeg === downKey && isQuoting ? 'Getting live quote...' : downQuote ? `${formatDusdc(downQuote.quoteAmount)} DUSDC` : `in ${countdown(market.expiry, now)}`}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </article>
              );
            })}
          </section>

          <aside className={styles.rail}>
            <section className={styles.ticket}>
              <header className={styles.panelHeader}>
                <div>
                  <h2 className={styles.panelTitle}>Bet ticket</h2>
                  <p className={styles.panelSubline}>{selectedLegs.length} of {previewConstants.maxLegs.toString()} legs selected</p>
                </div>
              </header>
              <div className={styles.ticketBody}>
                <div className={styles.quantityRow}>
                  <label>
                    <span className={styles.label}>Position quantity</span>
                    <input className={styles.quantity} inputMode="numeric" value={quantityInput} onChange={(event) => setQuantityInput(event.target.value)} />
                  </label>
                  <div className={styles.balance}>
                    <span className={styles.label}>Spendable</span>
                    <strong>{formatDusdc(balance)} DUSDC</strong>
                  </div>
                </div>

                <div className={styles.legList}>
                  {selectedLegs.length === 0 ? (
                    <div className={styles.empty}>Choose at least two BTC outcomes from the board. Your quoted contracts will appear here.</div>
                  ) : null}
                  {selectedLegs.map((leg, index) => (
                    <div className={styles.ticketLeg} key={legKey(leg)}>
                      <span className={styles.legNumber}>{index + 1}</span>
                      <div>
                        <div className={styles.ticketLegTitle}>{contractLabel(leg)}</div>
                        <div className={styles.ticketLegMeta}>Resolves {expiryClock(leg.expiry)} / {countdown(leg.expiry, now)}</div>
                        <div className={styles.ticketLegPrice}>Cost {formatDusdc(leg.quoteAmount)} DUSDC</div>
                      </div>
                      <button className={styles.remove} onClick={() => setSelectedLegs((current) => current.filter((item) => legKey(item) !== legKey(leg)))}>Remove</button>
                    </div>
                  ))}
                </div>

                <div className={styles.summary}>
                  <div className={styles.summaryRow}><span>Stake required</span><strong>{formatDusdc(preview.requiredStake)} DUSDC</strong></div>
                  <div className={styles.summaryRow}><span>Combined odds</span><strong>{formatOdds(preview.combinedOdds)}</strong></div>
                  <div className={styles.summaryRow}><span>LP bonus</span><strong>+{formatDusdc(preview.bonusAmount)} DUSDC</strong></div>
                  <div className={`${styles.summaryRow} ${styles.returnRow}`}><span>Potential return</span><strong>{formatDusdc(preview.potentialPayout)} DUSDC</strong></div>
                </div>

                {(message || quoteError) ? (
                  <div className={`${styles.message} ${(message?.kind === 'error' || quoteError) ? styles.error : styles.success}`} aria-live="polite">
                    {message?.text ?? quoteError}
                  </div>
                ) : null}

                <button className={styles.place} disabled={!canPlace} onClick={() => void submitSlip()}>
                  {isPlacing
                    ? 'Confirming on Sui...'
                    : !address
                      ? 'Connect wallet to place'
                      : selectedLegs.length < 2
                        ? 'Select at least 2 legs'
                        : preview.requiredStake > balance
                          ? 'Insufficient DUSDC'
                          : `Place ${selectedLegs.length}-leg slip`}
                </button>
              </div>
            </section>

            <section className={styles.portfolio}>
              <header className={styles.panelHeader}>
                <div>
                  <h2 className={styles.panelTitle}>Your slips</h2>
                  <p className={styles.panelSubline}>Execution and oracle status by leg</p>
                </div>
              </header>
              <div className={styles.portfolioBody}>
                <div className={styles.receiptList}>
                  {(receipts ?? []).slice(0, 8).map((receipt: SlipReceipt) => {
                    const pending = pendingIds.has(receipt.receiptId);
                    const active = activeIds.has(receipt.receiptId);
                    const expiredPending = pending && receipt.legs.some((leg) => Number(leg.expiry) <= now);
                    const states = receipt.legs.map((leg) =>
                      resolvedLegState(leg, settlementMap.get(leg.oracleId), pending, active, now),
                    );
                    const status = expiredPending
                      ? { label: 'Expired - cancel', className: styles.statusLost }
                      : receiptStatus(states, pending, active);
                    return (
                      <article className={styles.receipt} key={receipt.receiptId}>
                        <div className={styles.receiptHeader}>
                          <div>
                            <div className={styles.receiptId}>{shortId(receipt.receiptId)}</div>
                            <div className={styles.receiptHeadline}>{receipt.legs.length}-leg BTC slip</div>
                          </div>
                          <span className={`${styles.status} ${status.className}`}>{status.label}</span>
                        </div>
                        <div className={styles.receiptMetrics}>
                          <div className={styles.receiptMetric}><span className={styles.label}>Stake</span><strong>{formatDusdc(receipt.stake)}</strong></div>
                          <div className={styles.receiptMetric}><span className={styles.label}>Return</span><strong>{formatDusdc(receipt.potentialPayout)}</strong></div>
                          <div className={styles.receiptMetric}><span className={styles.label}>Bonus</span><strong>{formatDusdc(receipt.bonusAmount)}</strong></div>
                        </div>
                        <div className={styles.receiptLegs}>
                          {receipt.legs.map((leg, index) => {
                            const state = states[index];
                            return (
                              <div className={styles.receiptLeg} key={legKey(leg)}>
                                <span className={`${styles.dot} ${state === 'won' ? styles.dotWon : state === 'lost' ? styles.dotLost : ''}`} />
                                <span>{contractLabel(leg)} / {expiryClock(leg.expiry)}</span>
                                <span className={styles.legState}>{state}</span>
                              </div>
                            );
                          })}
                        </div>
                        {pending ? (
                          <button className={styles.cancel} disabled={cancelId === receipt.receiptId} onClick={() => void cancelSlip(receipt.receiptId)}>
                            {cancelId === receipt.receiptId ? 'Cancelling...' : 'Cancel pending slip'}
                          </button>
                        ) : null}
                      </article>
                    );
                  })}
                  {receipts && receipts.length === 0 ? <div className={styles.empty}>No slips yet. Build your first BTC view above.</div> : null}
                  {!address ? <div className={styles.empty}>Connect your wallet to see live and settled slip status.</div> : null}
                </div>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
