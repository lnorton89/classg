/**
 * Config fixtures — transcribed from the real files they mirror:
 *   services/sensor-wifi/config/channels.yaml
 *   the weight table in docs/architecture/data-model.md
 */
import type { ChannelPlan, FusionWeights } from '@/lib/api/types'

export const channelPlan: ChannelPlan = {
  channels: [
    { channel: 6, freq_mhz: 2437, weight: 40.0 },
    { channel: 1, freq_mhz: 2412, weight: 15.0 },
    { channel: 11, freq_mhz: 2462, weight: 15.0 },
    { channel: 2, freq_mhz: 2417, weight: 1.7 },
    { channel: 3, freq_mhz: 2422, weight: 1.7 },
    { channel: 4, freq_mhz: 2427, weight: 1.7 },
    { channel: 5, freq_mhz: 2432, weight: 1.7 },
    { channel: 7, freq_mhz: 2442, weight: 1.7 },
    { channel: 8, freq_mhz: 2447, weight: 1.7 },
    { channel: 9, freq_mhz: 2452, weight: 1.7 },
    { channel: 10, freq_mhz: 2457, weight: 1.7 },
    { channel: 12, freq_mhz: 2467, weight: 1.05 },
    { channel: 13, freq_mhz: 2472, weight: 1.05 },
    { channel: 36, freq_mhz: 5180, weight: 3.0 },
    { channel: 40, freq_mhz: 5200, weight: 2.0 },
    { channel: 44, freq_mhz: 5220, weight: 3.0 },
    { channel: 48, freq_mhz: 5240, weight: 2.0 },
    { channel: 149, freq_mhz: 5745, weight: 3.0 },
    { channel: 157, freq_mhz: 5785, weight: 2.0 },
  ],
}

export const fusionWeights: FusionWeights = {
  weights: { A: 0.6, B: 0.5, C: 0.1, E: 0.3, F: 0.25, G: 0.6 },
}
