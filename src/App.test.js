import { render, screen } from '@testing-library/react';
import App from './App';

jest.mock('onnxruntime-web', () => ({
  __esModule: true,
  default: {},
  env: { wasm: {} },
  InferenceSession: { create: jest.fn() },
  Tensor: jest.fn(),
}));

test('renders join form and mode nav', () => {
  render(<App />);
  expect(
    screen.getByText(/LiveKit noise cancellation test/i),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Model lab/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Join room/i })).toBeInTheDocument();
});
