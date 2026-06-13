"""
audio_buffer.py — Fixed-size circular buffer for 16-bit mono PCM audio.

Each buffer holds 48 000 samples (3 seconds at 16 kHz).
The buffer is only marked "ready" once it has been completely
filled for the first time; after that it stays ready and older
samples are silently overwritten as new data arrives.
"""

import numpy as np

SAMPLE_RATE = 16_000          # Hz
BUFFER_SECONDS = 3            # seconds of audio to retain
BUFFER_SIZE = SAMPLE_RATE * BUFFER_SECONDS   # 48 000 samples


class AudioBuffer:
    """Thread-safe-ish circular buffer backed by a numpy int16 array."""

    def __init__(self, node_id: str) -> None:
        self.node_id = node_id
        self._buf = np.zeros(BUFFER_SIZE, dtype=np.int16)
        self._write_pos = 0          # next index to write to
        self._total_written = 0      # lifetime sample counter
        self._ready = False          # flips True after first full fill

    # ── public API ────────────────────────────────────────────

    @property
    def ready(self) -> bool:
        """True once the buffer has been filled at least once."""
        return self._ready

    def write(self, samples: np.ndarray) -> None:
        """
        Append *samples* (int16 ndarray) into the ring buffer.

        If *samples* is longer than BUFFER_SIZE the oldest portion
        is silently dropped and only the last BUFFER_SIZE samples
        are kept.
        """
        n = len(samples)
        if n == 0:
            return

        # If the incoming chunk is bigger than the whole buffer,
        # just keep the tail.
        if n >= BUFFER_SIZE:
            samples = samples[-BUFFER_SIZE:]
            n = BUFFER_SIZE

        end = self._write_pos + n

        if end <= BUFFER_SIZE:
            # Fast path — fits without wrapping
            self._buf[self._write_pos:end] = samples
        else:
            # Wraps around the end of the array
            first = BUFFER_SIZE - self._write_pos
            self._buf[self._write_pos:] = samples[:first]
            self._buf[:n - first] = samples[first:]

        self._write_pos = end % BUFFER_SIZE
        self._total_written += n

        if not self._ready and self._total_written >= BUFFER_SIZE:
            self._ready = True

    def read(self) -> np.ndarray:
        """
        Return a *copy* of the current buffer contents in
        chronological order (oldest sample first).

        Raises RuntimeError if the buffer is not yet ready.
        """
        if not self._ready:
            raise RuntimeError(
                f"Buffer for {self.node_id} is not ready yet "
                f"({self._total_written}/{BUFFER_SIZE} samples written)"
            )
        # The oldest sample sits at _write_pos (it will be
        # overwritten next), so we rotate the array.
        return np.roll(self._buf, -self._write_pos).copy()

    def slide(self, n: int) -> None:
        """
        Discard the oldest *n* samples, shifting the remaining
        audio to the front of the buffer.

        After sliding the buffer needs *n* more new samples
        before it is "ready" again, which naturally throttles
        inference to every ~1 second of incoming audio.
        """
        if n <= 0 or n > BUFFER_SIZE:
            return

        # Read the current chronological snapshot
        ordered = self.read()           # full 48 000-sample copy

        # Keep the newest (BUFFER_SIZE - n) samples
        keep = ordered[n:]              # length = BUFFER_SIZE - n

        # Reset the internal ring buffer
        self._buf[:len(keep)] = keep
        self._buf[len(keep):] = 0
        self._write_pos = len(keep)

        # Subtract so the buffer must receive n more samples
        # before ready flips back to True.
        self._total_written = len(keep)
        self._ready = False

    def __repr__(self) -> str:
        pct = min(self._total_written / BUFFER_SIZE * 100, 100)
        state = "ready" if self._ready else "filling"
        return (
            f"<AudioBuffer node={self.node_id} "
            f"{state} {pct:.0f}% "
            f"write_pos={self._write_pos}>"
        )
