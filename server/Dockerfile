FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
ENV PORT=8080 DB_PATH=/data/data.db
RUN mkdir /data && chown node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
