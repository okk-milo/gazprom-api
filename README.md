# gazprom-api

## Incremental antifraud analysis

The API owns call orchestration and splits the transcript into consecutive
windows (up to 32 segments, 4000 text characters and 120 seconds of audio).
No segments are dropped to satisfy a whole-call LLM limit. The internal LLM
URL configured by `LLM_INTERNAL_URL` keeps its legacy value; the API appends
`/windows` for the bounded contract. Deploy that endpoint and its private
Nginx route before deploying this API version.

After each window the API persists updated roles, exact-quote highlights,
accumulated factors and one actual score at the end of the window. Only prior
summary and two prior turns are sent as context; future windows are not used.
The UI's existing 3-second polling reads these partial results. This polling
frequency is not a guarantee of a new model assessment every three seconds.
Constant scores are allowed; synthetic +/-18 confidence adjustments are gone.

Window failures retain the transcript but clear the incomplete score and mark
the call failed. Increasing an input limit alone is not a long-call fix.
Old saved results are not rewritten by deployment. Benchmark by re-uploading
the same recordings and compare latency, quotations, roles and coverage.
