FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# CUDA 12.8 wheels include Blackwell (RTX 50xx) kernels.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cu128 \
    && pip install --no-cache-dir "laya[serve]==0.3.22"

ENV LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000 \
    LAYA_DEVICE=cuda \
    LAYA_MODELS=multilingual,typed-decisions \
    LAYA_PRELOAD=1 \
    LAYA_MAX_TOKEN_BUDGET=8192
EXPOSE 8000
CMD ["laya-serve"]
