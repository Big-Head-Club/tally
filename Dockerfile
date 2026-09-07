# Standalone collector image. `fly launch` or Railway picks this up.
FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
ENV NODE_ENV=production TALLY_DIR=/data PORT=8787
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
