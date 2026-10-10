# Not adapted from any branch. One engine default the reader can read, and one
# whose default is itself a substitution, which it cannot: the match ends at the
# inner closing brace, so the value would arrive with a brace missing.

SRT_LATENCY="${SRT_LATENCY:-${FALLBACK_LATENCY:-200}}"
HLS_WINDOW="${HLS_WINDOW:-22.5}"
