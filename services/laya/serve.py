"""Serve upstream Laya beside Gemma with a bounded CUDA allocation budget."""

import torch
import uvicorn
from laya.serve import build_router, create_app

if not torch.cuda.is_available():
    raise RuntimeError("The Patch classifier requires CUDA")

device_bytes = torch.cuda.get_device_properties(0).total_memory
# Upstream loads F32 weights before restoring the checkpoint's original F16 values.
torch.cuda.set_per_process_memory_fraction(2 * 1024**3 / device_bytes, 0)
torch.backends.cuda.enable_math_sdp(False)
router = build_router()
agent = router.load("english")
if agent.device.type != "cuda":
    raise RuntimeError("Laya did not load on CUDA")
temperature = agent.model.temperature.detach().clone()
agent.model.half()
agent.model.temperature.data = temperature
agent.model.encoder.set_attn_implementation("sdpa")
torch.cuda.empty_cache()
torch.cuda.set_per_process_memory_fraction(1.5 * 1024**3 / device_bytes, 0)


class ReleaseWorkspace:
    """Return unused temporary allocations to the shared GPU after each decision."""

    def on_predict_end(self, context):
        torch.cuda.empty_cache()


router.add_hook(ReleaseWorkspace())
uvicorn.run(create_app(router=router), host="127.0.0.1", port=18792, log_level="info")
