FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY src/ ./src/

RUN mkdir -p uploads/temp

EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "src/index.js"]

# rebuild trigger 1781008616
