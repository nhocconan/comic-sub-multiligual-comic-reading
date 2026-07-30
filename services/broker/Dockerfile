FROM node:22.22.0-alpine

WORKDIR /app
COPY --chown=node:node packages ./packages
COPY --chown=node:node services/broker ./services/broker

RUN mkdir -p /data && chown node:node /data

USER node
WORKDIR /app/services/broker
ENV BROKER_HOST=0.0.0.0 \
    BROKER_PORT=4100 \
    BROKER_DATA_DIR=/data \
    KOHARU_ENDPOINT=http://koharu:4000/api/v1
EXPOSE 4100
CMD ["node", "src/main.js"]
