FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js db.js schema.sql words.json ./
ENV PORT=8080
ENV DB_PATH=/data/vocab.db
EXPOSE 8080
CMD ["node", "server.js"]
