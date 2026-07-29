import { render, screen } from '@testing-library/react';
import App from './App';

test('renders join form', () => {
  render(<App />);
  expect(
    screen.getByText(/LiveKit noise cancellation test/i),
  ).toBeInTheDocument();
  expect(screen.getByLabelText(/Token/i)).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /Generate token/i }),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Join room/i })).toBeInTheDocument();
});
