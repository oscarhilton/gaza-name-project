# Use Node.js LTS version
FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev dependencies)
RUN npm install

# Copy app source
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV NEXT_PUBLIC_API_URL=http://backend:3001

# Build the Next.js application
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Expose the port
EXPOSE 3000

# Start the application
CMD ["npm", "start"] 