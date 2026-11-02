// Chainflip: native SOL → native BTC, no account, no identity. The engine
// asks for a quote, opens a deposit channel (destination = the BTC address
// we want funded), sends SOL to the channel's Solana address and then
// watches the swap until the BTC egress tx is known.
//
//   const cf = new Chainflip();
//   const q = await cf.quote(lamports)                    → best REGULAR quote
//   const ch = await cf.channel({ quote, destAddress, refundAddress })
//   await cf.status(ch.depositChannelId)                  → { state, swapId, egressTxRef, ... }
import { SwapSDK } from '@chainflip/sdk/swap';

export const EXPLORER = 'https://scan.chainflip.io';

export class Chainflip {
  constructor({ network = 'mainnet', slippagePct = 1, log = console } = {}) {
    this.sdk = new SwapSDK({ network });
    this.slippagePct = slippagePct;
    this.log = log;
  }

  async limits() {
    const l = await this.sdk.getSwapLimits();
    return { minLamports: Number(l.minimumSwapAmounts.Solana.SOL), minSats: Number(l.minimumSwapAmounts.Bitcoin.BTC) };
  }

  // Best regular (non-DCA) quote for `lamports` of SOL into BTC.
  async quote(lamports) {
    const r = await this.sdk.getQuoteV2({ srcChain: 'Solana', srcAsset: 'SOL', destChain: 'Bitcoin', destAsset: 'BTC', amount: String(lamports), isVaultSwap: false });
    const q = r.quotes.find(x => x.type === 'REGULAR') ?? r.quotes[0];
    if (!q) throw new Error('chainflip returned no quote');
    return q;
  }

  // Opens a deposit channel. Funds sent to `depositAddress` (Solana) come out
  // as BTC at `destAddress`; if the price moves past the tolerance within
  // `retryDurationMinutes` the SOL is refunded to `refundAddress`.
  async channel({ quote, destAddress, refundAddress, retryDurationMinutes }) {
    const ch = await this.sdk.requestDepositAddressV2({
      quote, destAddress, srcAddress: refundAddress,
      fillOrKillParams: { refundAddress, slippageTolerancePercent: this.slippagePct, retryDurationBlocks: Math.round((retryDurationMinutes ?? quote.recommendedRetryDurationMinutes ?? 30) * 10) },
    });
    return { depositChannelId: ch.depositChannelId, depositAddress: ch.depositAddress, expiresAt: ch.estimatedDepositChannelExpiryTime ?? null, brokerBps: ch.brokerCommissionBps };
  }

  // Status by deposit channel id (chain-block-channel) or by swap id / tx hash.
  async status(id) {
    const s = await this.sdk.getStatusV2({ id });
    return {
      state: s.state, swapId: s.swapId ?? null,
      depositAmount: s.deposit?.amount ?? null, depositTxRef: s.deposit?.txRef ?? null,
      egressAmount: s.swapEgress?.amount ?? null, egressTxRef: s.swapEgress?.txRef ?? null,
      refundTxRef: s.refundEgress?.txRef ?? null, failure: s.swapEgress?.failure ?? s.deposit?.failure ?? null,
      expired: s.depositChannel?.isExpired ?? false,
    };
  }

  static links({ depositChannelId, swapId }) {
    const out = {};
    if (depositChannelId) out.channel = `${EXPLORER}/channels/${depositChannelId}`;
    if (swapId) out.swap = `${EXPLORER}/swaps/${swapId}`;
    return out;
  }
}
