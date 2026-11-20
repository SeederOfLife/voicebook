# Voicebook voice + AI server (studio voice, AI casting). Used by Google Cloud Run
# ("Continuously deploy from a repository": it builds this file at every push to main).
# Any Docker host works; the port comes from $PORT (Cloud Run: 8080, Hugging Face: 7860).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --no-audit --no-fund

# The voice model (326 MB), inside the image so the server starts ready. Before the code
# is copied, so updates to the code reuse it instead of downloading it again.
RUN mkdir -p models && curl -fsSL -o models/kokoro-v1.0.onnx \
    https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx

COPY . .
RUN npx next build

ENV NODE_ENV=production HOSTNAME=0.0.0.0 \
    KOKORO_MODEL=fp32 KOKORO_MODEL_PATH=/app/models/kokoro-v1.0.onnx \
    STUDIO_MONTHLY_HOURS=0
EXPOSE 8080
CMD ["sh", "-c", "exec npx next start -H 0.0.0.0 -p ${PORT:-8080}"]
