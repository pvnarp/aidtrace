FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
RUN npm install --global pnpm@10.20.0
ENV PNPM_HOME=/pnpm \
    NEXT_TELEMETRY_DISABLED=1
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace
CMD ["pnpm", "dev", "--hostname", "0.0.0.0"]
