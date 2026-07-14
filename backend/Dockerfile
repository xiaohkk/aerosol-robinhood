FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application
COPY . .

# Build TypeScript files
RUN npm run build

# Remove development dependencies
RUN npm prune --production

# Start the application
CMD ["node", "dist/bot/samplebot.js"] 