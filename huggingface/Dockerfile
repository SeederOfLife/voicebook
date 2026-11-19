# Voicebook voice server for a Hugging Face Space (Docker, free CPU: 2 cores, 16 GB).
# It builds the app straight from the public GitHub repository, with the full-quality
# voice model inside, and serves the voice + AI routes on port 7860.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 user || true
USER 1000
ENV HOME=/home/user NEXT_TELEMETRY_DISABLED=1
WORKDIR /home/user/app

# Bumped by the GitHub workflow at every change, so the Space rebuilds with the newest code.
ARG REVISION=main
RUN git clone --depth 1 https://github.com/SeederOfLife/voicebook.git . \
    && (git fetch --depth 1 origin "$REVISION" && git checkout -q FETCH_HEAD || true) \
    && rm -rf android public/download huggingface

RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --no-audit --no-fund
RUN npx next build

# The voice model (326 MB), inside the image so the server starts ready.
RUN mkdir -p models && curl -fsSL -o models/kokoro-v1.0.onnx \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx

ENV NODE_ENV=production PORT=7860 HOSTNAME=0.0.0.0 \
    KOKORO_MODEL=fp32 KOKORO_MODEL_PATH=/home/user/app/models/kokoro-v1.0.onnx \
    STUDIO_MONTHLY_HOURS=0
EXPOSE 7860
CMD ["npx", "next", "start", "-p", "7860", "-H", "0.0.0.0"]
