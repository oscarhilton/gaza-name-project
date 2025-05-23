# Use Node.js LTS version
FROM node:20-slim

# Install system dependencies including ffmpeg and curl
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev dependencies)
RUN npm install

# Copy app source
COPY . .

# Build TypeScript files
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Create directories for audio files
RUN mkdir -p uploads processed

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001

# Expose the port
EXPOSE 3001

# Start the application
CMD ["node", "dist/index.js"] 