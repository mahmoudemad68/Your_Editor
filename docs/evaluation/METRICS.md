# Evaluation metrics

<!-- Generated from metrics.json by tools/evaluation/docs.mjs. -->

Schema 1.0; dataset evaluation-dataset-v1. Machine outputs use ratios, milliseconds, seconds or typed counts exactly as specified below. A missing gold input produces no score, never an inferred reference.

## Caption word error rate (`caption_wer`)

**Definition:** Token-level Levenshtein errors against approved human word text, reported separately for each language.

**Formula:** WER = (S + D + I) / N

**Unit:** ratio

**Direction:** minimize

**Aggregation:** Micro-average sums of S,D,I,N per language. Percentage display = 100 * ratio; do not average clip percentages.

**Edge cases:** N=0 and zero hypothesis tokens: null (no reference); N=0 and nonempty hypothesis: null plus insertion count. Never divide by zero or report a perfect score for an unlabelled clip.

**Normalization / protocol:** NFC Unicode, then Unicode casefold; remove Arabic U+064B..U+065F, U+0670 and tatweel U+0640; no Arabic letter folding (alef/hamza/ya/ta marbuta remain distinct). Replace every Unicode P* punctuation character with a space. Map Unicode Nd decimal digits to ASCII digits; never expand number words or regroup numbers. Collapse Unicode whitespace and split on spaces. Preserve original gold text unchanged. Pin the scorer Unicode database/version in each report.

**First reporting story:** US-201

**Roadmap rationale:** US-201-T3 compares WER on hand-aligned fixtures; AC1 requires English <=12% and records Arabic. CP2 repeats this gate.

**Required inputs:** approved word alignment; predicted caption text; language.

## Caption synchronization error (`caption_sync_error`)

**Definition:** Median absolute word-start timestamp error on normalized exact-token matches from the WER alignment. Word-end errors and match coverage are mandatory diagnostics.

**Formula:** error_i_ms = abs(predictedStartUs_i - goldStartUs_i) / 1000; score = median(error_i_ms); coverage = matchedGoldWords / N

**Unit:** milliseconds

**Direction:** minimize

**Aggregation:** Pool matched-word start errors per language, then take the median (even count: mean of middle two). Also report p95, median end error, match count and coverage.

**Edge cases:** No matched words: null, coverage=0; N=0: null coverage. Substitutions/deletions are not treated as accurate timestamps. Report coverage alongside the CP2 <=100ms gate so omissions cannot improve a score silently.

**Normalization / protocol:** Use the caption WER text normalization only for lexical matching; raw integer microsecond start/end values are never rounded before subtraction.

**First reporting story:** US-201

**Roadmap rationale:** US-201 supplies word-level timestamps and hand-aligned fixtures; CP2 requires median word-timestamp error <=100ms. This registry makes the start-boundary convention explicit.

**Required inputs:** approved word alignment; predicted word timestamps; WER alignment.

## Silence removal accuracy (`silence_removal_accuracy`)

**Definition:** Duration-overlap silence detection F1 is the canonical summary; removal additionally reports speech falsely removed and gold silence missed.

**Formula:** TP = duration(P intersect G); FP = duration(P minus G); FN = duration(G minus P); precision = TP/(TP+FP); recall = TP/(TP+FN); F1 = 2*TP/(2*TP+FP+FN)

**Unit:** ratio

**Direction:** maximize

**Aggregation:** Sum TP,FP,FN integer microseconds across clips before ratios. Separately report FP/1000000 seconds of falsely removed speech, FN/1000000 seconds missed silence and FP/duration(non-silence) speech removal rate.

**Edge cases:** Use half-open intervals [start,end), merged unions, no tolerance collar. Both P and G empty: precision=recall=F1=1 with no_silence=true; empty P/nonempty G: precision=1, recall=0, F1=0; nonempty P/empty G: precision=0, recall=1, F1=0. Empty speech denominator: null. Never label detector output as actual removal.

**Normalization / protocol:** Union sorted intervals in source time; integer microseconds for all overlap arithmetic. Do not expand gold boundaries or forgive speech removal.

**First reporting story:** US-202

**Roadmap rationale:** US-202-T3 benchmarks precision/recall against labelled silence; CP2 requires silence detection F1 >=0.9. US-204 consumes intervals; US-223 later reports the same primitive on actual cuts.

**Required inputs:** approved silence intervals G; predicted or actually removed intervals P; source duration.

## Content retention (`content_retention`)

**Definition:** Fraction of duration of Owner-labelled required-content spans retained by the output edit. This baseline measures labelled temporal coverage, not automated semantic quality.

**Formula:** retention = duration(requiredSourceSpans intersect retainedSourceSpans) / duration(requiredSourceSpans)

**Unit:** ratio

**Direction:** maximize

**Aggregation:** Micro-average numerator/denominator durations over clips; report per-clip values and human-reviewed required spans with version/SHA.

**Edge cases:** No required spans: null (not labelled). Overlapping spans unioned; repeated source content counts once; reordered content counts as retained. No score is available from the current unlabelled candidates. Required spans must be recorded before viewing the system result.

**Normalization / protocol:** No token/embedding proxy. Use integer microsecond half-open unions in source coordinates. The reviewer identifies facts/instructions that must survive, supplies rationale, and approves spans before evaluation.

**First reporting story:** US-307

**Roadmap rationale:** US-307-T5 explicitly computes content retention against human-selected highlights; AC3 requires reporting in the evaluation harness. Earlier edit/render stories do not own this semantic evaluation.

**Required inputs:** human-approved required-content spans; output-to-source edit mapping.

## Render success rate (`render_success_rate`)

**Definition:** Successful logical render requests divided by attempted logical render requests; internal retries belong to the same request.

**Formula:** successRate = successfulLogicalRequests / attemptedLogicalRequests

**Unit:** ratio

**Direction:** maximize

**Aggregation:** Pool logical request counts, report successes and failures by reason and backend; percentage display = 100 * ratio.

**Edge cases:** Attempt starts after input validation when the worker accepts a render request. Invalid input before admission is excluded and separately counted. Infrastructure failure after admission counts as failure. A success requires completed render, existing nonempty decodable output and expected duration within configured tolerance. User cancellation before or after admission is excluded from denominator and separately counted. Terminal retry exhaustion is one failure; successful retry is one success. No attempts: null.

**Normalization / protocol:** Deduplicate by logical request ID, never by queue attempt ID; report retry counts as diagnostics, not additional renders.

**First reporting story:** US-216

**Roadmap rationale:** US-216 first implements an actual renderer with ffprobe/visual output checks, establishing this outcome ledger; US-320 later aggregates it nightly. US-218 uses the same contract for FFmpeg.

**Required inputs:** logical request IDs; terminal render outcomes; output probe/check results.

## Editing time (`editing_time`)

**Definition:** Elapsed automated processing and active human correction time are separate outputs, never worker CPU time.

**Formula:** automatedSeconds = (terminalOutputReadyAt - acceptedEditRequestAt)/1000; humanCorrectionSeconds = sum(activeCorrectionIntervalEndMs - activeCorrectionIntervalStartMs)/1000

**Unit:** seconds

**Direction:** minimize

**Aggregation:** Report median and p95 per component, language and category, plus sample counts. Do not combine automated and human times into a single undocumented score.

**Edge cases:** Automated elapsed includes queue/retries/I/O. Failed/cancelled requests have null successful editing time and separately reported elapsed-to-failure. Human intervals start with first correction interaction and end at save/explicit pause; inactivity >60s pauses at last interaction. Overlaps unioned. No human correction: 0 only when a human explicitly records no correction; unobserved sessions: null. Clock reversal: invalid record.

**Normalization / protocol:** Monotonic elapsed clocks within a process; synchronized UTC event timestamps for cross-service wall time with recorded clock source. No CPU-time substitution.

**First reporting story:** US-613

**Roadmap rationale:** US-613-T2 explicitly measures editing time against US-110; earlier roadmap stories name render latency or agent iteration rather than this evaluation metric.

**Required inputs:** accepted request timestamp; terminal usable output timestamp; human active correction session intervals.

## Human acceptance rate (`human_acceptance_rate`)

**Definition:** Owner/raters watch source and proposed reel with the same brief, then choose accepted, accepted_with_minor_changes, or rejected.

**Formula:** acceptanceRate = count(accepted) / count(validHumanReviews)

**Unit:** ratio

**Direction:** maximize

**Aggregation:** Per-rater and pooled review-observation rates; also report relaxedRate=(accepted+accepted_with_minor_changes)/validHumanReviews and status counts. Each assigned rater/reel pair contributes once.

**Edge cases:** Only accepted enters the canonical numerator. Missing/unreviewed/withdrawn ratings are excluded and reported; no reviews: null. A changed reel needs a new version/review. AI ratings never enter the denominator. Minor changes mean usable after local caption/timing adjustments without changing the core selected content; other changes are rejected. Report inter-rater disagreement separately.

**Normalization / protocol:** No automatic classifier. Randomize presentation order and hide system identity where feasible; retain actual human records, never infer approval from a lack of corrections.

**First reporting story:** US-426

**Roadmap rationale:** US-426 first runs an MVP pilot with at least three human raters and six videos and records manual corrections; US-614 later expands the formal acceptance study.

**Required inputs:** human reviewer pseudonymous ID; source/reel SHA and brief version; review status.

## Manual corrections (`manual_corrections`)

**Definition:** Typed counts of human corrections needed to accept an output; incomparable correction types remain separate.

**Formula:** captionWordCorrections = S + D + I between draft and human-final captions; timelineOperations = count(committed human timeline commands); manualInterventions = count(explicit human intervention episodes)

**Unit:** count per type

**Direction:** minimize

**Aggregation:** Sum and median per reel for each named type, with reviewed-reel denominator. Do not add the three types into one total.

**Edge cases:** Undo removes a command from final committed operation count; redo restores it. One command changing several clips is one operation. An intervention runs from an explicit takeover to save/resume. No changes=0 only with explicit human review. Unreviewed output=null; absent audit=null for that type. Automatic operations excluded.

**Normalization / protocol:** Caption differences use the WER normalization, but also preserve raw draft/final captions for audit; punctuation-only fixes are a separate optional diagnostic, not normalized word corrections.

**First reporting story:** US-426

**Roadmap rationale:** US-426-T2 explicitly records manual corrections in the first MVP pilot; US-613 later compares the same typed counts in the release evaluation.

**Required inputs:** draft/final captions; committed command audit; human intervention records; human-reviewed reel ID.
