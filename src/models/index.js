import { deepFilterNetOrtModel } from './deepfilternetOrt';

/** Registry of offline noise models. Swap / add adapters here later. */
export const NOISE_MODELS = [deepFilterNetOrtModel];

export function getNoiseModel(id) {
  return NOISE_MODELS.find((model) => model.id === id) || NOISE_MODELS[0];
}
