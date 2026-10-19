# Laya response classifier

Patch calls an independent `POST /v1/systemone` endpoint for reply timing. The two choices are `respond` and `dont respond`. The response model, Remora credentials, memory declarations and generation retries never enter this call.

The prompt follows Laya's [typed-question guidance](https://nandhakishorm.github.io/laya/questions-and-answers/). Instructions describe the decision. Criteria describe each action. State contains recent dialogue, the latest message and resolved reply authors. It excludes Patch's response persona, slang examples and JSON-generation instructions. The [research note](laya-prompting-research.md) records the primary sources and known limitations.

`prompts/20-classifier.md` owns the decision instructions. `src/prompts/classifier.ts` renders state and criteria. The API budget is 8192 total tokens and 512 question tokens. Oversized state, malformed results and transport failures produce silence without a response-model fallback. This budget is a transport ceiling, not proof of long-conversation accuracy. Patch logs the winning option's `answer_confidence`; it applies no uncalibrated confidence threshold.

## Measured results

On 2026-10-19, the unchanged Gemma prompt passed 4/8 archived cases on multilingual Laya. Compact structured state passed 3/8. Readable dialogue passed 3/8 on multilingual and 6/8 on English. The final concise policy also passed 6/8 on English, with no truncation or CPU fallback. These are development cases used during prompt work, not held-out accuracy.

The final prompt handles ambient acknowledgement, human-directed replies, role pings, discussion about Patch and a short continuation. It misses indirect address without a mention and a correction phrased in third person. Warm HTTP calls took about 29–35 ms in this run; the first took 73 ms. This is a small classifier-only measurement while Gemma stayed loaded.

A later development variant added contrasting indirect-address examples. It passed 7/8, fixing the third-person correction but still rejecting "don't you, Patch?" at about 54% silence. That variant is not adopted. More explicit examples did not resolve the remaining indirect-address case.

Both `RESPONSE_CLASSIFIER_ENABLED` and `DM_RESPONSE_CLASSIFIER_ENABLED` remain false in the scoped trial. No prompt edit enables them. Live Patch remains on its existing immutable caller build until a separate caller deployment. The implementation is available for testing; these eight cases do not qualify automatic conversation gating.

## Local GPU service

The ML companion uses upstream Python Laya. Patch's client and conversation runtime remain TypeScript. Install [services/laya/requirements.txt](../services/laya/requirements.txt) in a separate environment with PyTorch's CUDA 12.6 package index. Download `convaiinnovations/laya` at revision `7b928d828b7b0e022f929d9bd2e44165aa270148`. Do not install into Remora's environment.

Set these environment variables before running [serve.py](../services/laya/serve.py):

```sh
LAYA_DEVICE=cuda
LAYA_MODELS=english
LAYA_DEFAULT_MODEL=english
LAYA_EXTRA_MODELS='{"english":"/absolute/path/to/pinned/checkpoint"}'
LAYA_MAX_LOADED=1
LAYA_MAX_CONCURRENT=1
LAYA_MAX_TOKEN_BUDGET=8192
LAYA_MAX_BATCH_TOKENS=8192
LAYA_THREADS=2
LAYA_CUDA_AMP=fp16
TOKENIZERS_PARALLELISM=false
OMP_NUM_THREADS=2
MKL_NUM_THREADS=2
PYTORCH_ALLOC_CONF=expandable_segments:True
```

The launcher binds loopback `127.0.0.1:18792`, restores F16 weights with F32 temperatures, and caps the CUDA allocator at 2 GiB during startup and 1.5 GiB during serving. Those caps exclude CUDA driver overhead. The English checkpoint uses SDPA. Earlier 8k multilingual experiments needed FlexAttention to avoid a quadratic mask allocation; those failures remain recorded.

The current user service is `patch-laya-classifier.service`. Its environment, pinned checkpoint, logs and evaluation artifacts live under `/home/mia/.cache/patch-laya-classifier`. Check `/health` for actual `checkpoint_devices.english == "cuda"` and zero `cpu_fallbacks.english.count`; a requested CUDA device alone does not prove GPU execution. Coordinate this service with Remora before future exclusive GPU work.
