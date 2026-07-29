import { deepFilterNetOrtModel } from './deepfilternetOrt';
import { rnnoiseWasmModel } from './rnnoiseWasm';
import { dfnSileroVadModel } from './dfnSileroVad';
import { webrtcApmModel } from './webrtcApm';
import { nsnet2Model } from './nsnet2Ort';

/** Registry of offline noise models. Swap / add adapters here later. */
export const NOISE_MODELS = [deepFilterNetOrtModel, rnnoiseWasmModel, dfnSileroVadModel, webrtcApmModel, nsnet2Model];

export function getNoiseModel(id) {
  return NOISE_MODELS.find((model) => model.id === id) || NOISE_MODELS[0];
}
