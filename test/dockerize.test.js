// Dockerize (app/js/dockerize.js): what kind of project a folder holds, and the Docker files for
// it. The projects are written here as files in memory (a .js file under test/ would be run by
// node --test as a test), read through the same `io` the dialog gives scanProject.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cmdLine,
  defaultOptions,
  detectProject,
  dockerPlan,
  findProjectRoot,
  imageName,
  listensLocally,
  looksLikeProject,
  meets,
  offlineBuildLine,
  optionProblem,
  parentFolder,
  pickVersion,
  portIn,
  readToml,
  requirementNames,
  reviewQuestion,
  scanProject,
  servesPort,
  solutionProjects,
  splitWords,
  VERSIONS,
} from '../app/js/dockerize.js';
import { PROJECTS as CHECKED } from '../scripts/docker-projects.mjs';

/** A folder in memory: { 'dir/name': text, 'empty-dir/': null }. `reads` lists what was read. */
function memIo(files) {
  const all = Object.keys(files);
  const reads = [];
  return {
    reads,
    list: async (rel) => {
      const prefix = rel ? `${rel}/` : '';
      if (rel && !all.some((p) => p.startsWith(prefix))) throw new Error(`${rel}: no such folder`);
      const names = new Map();
      for (const p of all) {
        if (!p.startsWith(prefix)) continue;
        const [first, ...more] = p.slice(prefix.length).split('/');
        if (!first) continue;
        const dir = more.length > 0;
        if (!names.has(first) || dir) names.set(first, { name: first, dir, size: dir ? 0 : String(files[p] ?? '').length });
      }
      return [...names.values()];
    },
    read: async (rel) => {
      reads.push(rel);
      if (typeof files[rel] !== 'string') throw new Error(`${rel}: not there`);
      return files[rel];
    },
  };
}

const json = (v) => JSON.stringify(v, null, 2);

const PROJECTS = {
  express: {
    'package.json': json({ name: 'shop-api', main: 'server.js', scripts: { start: 'node server.js', dev: 'nodemon server.js' }, engines: { node: '>=20' }, dependencies: { express: '^4.19.0' } }),
    'package-lock.json': '{}',
    'server.js': "const express = require('express');\nconst app = express();\nconst port = process.env.PORT || 4000;\napp.listen(port);\n",
    '.env.example': 'DATABASE_URL=\nSECRET=\n',
    '.env': 'SECRET=hunter2\n',
    'data/.keep': '',
    'uploads/a.png': 'x',
  },
  vite: {
    'package.json': json({ name: 'dashboard', scripts: { dev: 'vite', build: 'vite build', start: 'vite preview' }, dependencies: { react: '^18.3.0' }, devDependencies: { vite: '^5.4.0', '@vitejs/plugin-react': '^4.3.0' } }),
    'package-lock.json': '{}',
    'index.html': '<div id="root"></div>',
    'vite.config.js': "export default { build: { outDir: 'public-dist' } }",
    'src/main.jsx': 'import React from "react";',
  },
  next: {
    'package.json': json({ name: 'site', packageManager: 'pnpm@9.12.0', scripts: { dev: 'next dev', build: 'next build', start: 'next start' }, dependencies: { next: '15.0.0', react: '19.0.0' } }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'next.config.mjs': 'export default {}',
    '.nvmrc': 'v22.11.0\n',
  },
  nest: {
    'package.json': json({ name: 'api', scripts: { build: 'nest build', start: 'nest start', 'start:prod': 'node dist/main' }, dependencies: { '@nestjs/core': '^10.0.0', '@nestjs/common': '^10.0.0' }, devDependencies: { '@nestjs/cli': '^10.0.0' } }),
    'yarn.lock': '# yarn lockfile v1\n',
    'src/main.ts': "async function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(process.env.PORT ?? 3100);\n}\n",
  },
  angular: {
    'package.json': json({ name: 'shop', scripts: { start: 'ng serve', build: 'ng build' }, dependencies: { '@angular/core': '^18.0.0' }, devDependencies: { '@angular/cli': '^18.0.0' } }),
    'package-lock.json': '{}',
    'angular.json': json({ projects: { shop: { architect: { build: { builder: '@angular-devkit/build-angular:application', options: { outputPath: 'dist/shop' } } } } } }),
  },
  bun: {
    'package.json': json({ name: 'edge', scripts: { start: 'bun run src/index.ts' }, dependencies: { hono: '^4.0.0' } }),
    'bun.lock': '{}',
    'src/index.ts': "import { Hono } from 'hono';\nexport default { port: 8787, fetch: app.fetch };\n",
  },
  cli: {
    'package.json': json({ name: 'tool', main: 'cli.js' }),
    'cli.js': 'console.log(process.argv.slice(2).join(" "));\n',
  },
  fastapi: {
    'pyproject.toml': '[project]\nname = "notes-api"\nrequires-python = ">=3.11"\ndependencies = [\n  "fastapi>=0.110",\n  "uvicorn[standard]>=0.29",  # the server\n]\n\n[tool.uv]\ndev-dependencies = ["pytest"]\n',
    'uv.lock': 'version = 1\n',
    'app/__init__.py': '',
    'app/main.py': 'from fastapi import FastAPI\n\napi = FastAPI(title="Notes")\n\n@api.get("/")\ndef root():\n    return {"ok": True}\n',
  },
  flask: {
    'requirements.txt': '# web\nFlask==3.0.3\npython-dotenv>=1.0 ; python_version >= "3.8"\n-r extra.txt\n',
    'app.py': 'from flask import Flask\n\napp = Flask(__name__)\n\nif __name__ == "__main__":\n    app.run(debug=True)\n',
    '.python-version': '3.11.9\n',
    'instance/app.db': 'x',
  },
  factory: {
    'requirements.txt': 'flask\ngunicorn\n',
    'app/__init__.py': 'from flask import Flask\n\ndef create_app():\n    app = Flask(__name__)\n    return app\n',
    'wsgi.py': 'from app import create_app\n',
  },
  django: {
    'pyproject.toml': '[tool.poetry]\nname = "mysite"\n\n[tool.poetry.dependencies]\npython = "^3.10"\nDjango = "^5.0"\npsycopg2 = { version = "^2.9" }\n',
    'poetry.lock': '# lock\n',
    'manage.py': "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings')\n",
    'mysite/settings.py': 'DEBUG = True\n',
    'mysite/wsgi.py': 'application = None\n',
    'media/.keep': '',
    'db.sqlite3': 'x',
    'package.json': json({ name: 'styles', scripts: { build: 'tailwindcss -i in.css -o static/out.css' }, devDependencies: { tailwindcss: '^3.4.0' } }),
  },
  script: {
    'requirements.txt': 'requests\n',
    'main.py': 'import requests\nprint(requests.get("https://example.com").status_code)\n',
  },
  streamlit: {
    'requirements.txt': 'streamlit\npandas\n',
    'dashboard.py': 'x = 1\n',
    'app.py': 'import streamlit as st\nst.title("Hi")\n',
  },
  laravel: {
    'composer.json': json({ require: { php: '^8.2', 'laravel/framework': '^11.0', 'ext-gd': '*', 'ext-mbstring': '*', 'ext-intl': '*' } }),
    'composer.lock': '{}',
    artisan: '#!/usr/bin/env php\n',
    'public/index.php': '<?php\n',
    'package.json': json({ private: true, scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^5.0.0', 'laravel-vite-plugin': '^1.0.0' } }),
    'package-lock.json': '{}',
    'storage/app/.gitignore': '*\n',
    '.env.example': 'APP_KEY=\n',
  },
  php: {
    'index.php': '<?php echo "hi";\n',
    'about.php': '<?php\n',
  },
  dotnet: {
    'Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n',
    'Program.cs': 'var app = WebApplication.Create();\napp.Run();\n',
  },
  solution: {
    'Shop.sln': 'Microsoft Visual Studio Solution File, Format Version 12.00\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Shop.Web", "src\\Shop.Web\\Shop.Web.csproj", "{1}"\nEndProject\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Shop.Tests", "tests\\Shop.Tests\\Shop.Tests.csproj", "{2}"\nEndProject\n',
    'src/Shop.Web/Shop.Web.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup>\n    <TargetFrameworks>net8.0;net9.0</TargetFrameworks>\n    <AssemblyName>ShopWeb</AssemblyName>\n  </PropertyGroup>\n</Project>\n',
    'tests/Shop.Tests/Shop.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><TargetFramework>net9.0</TargetFramework><IsTestProject>true</IsTestProject></PropertyGroup>\n</Project>\n',
  },
  framework: {
    'Old.csproj': '<Project ToolsVersion="15.0">\n  <PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion><TargetFramework>net48</TargetFramework></PropertyGroup>\n</Project>\n',
  },
  go: {
    'go.mod': 'module github.com/me/inventory\n\ngo 1.22.3\n\nrequire github.com/go-chi/chi/v5 v5.0.12\n',
    'go.sum': 'x\n',
    'cmd/inventory/main.go': 'package main\n\nimport "net/http"\n\nfunc main() {\n\thttp.ListenAndServe(":9090", nil)\n}\n',
    'cmd/migrate/main.go': 'package main\n',
    'templates/index.html': '<p>',
  },
  gocgo: {
    'go.mod': 'module example.com/notes\n\ngo 1.23\ntoolchain go1.24.1\n\nrequire github.com/mattn/go-sqlite3 v1.14.22\n',
    'main.go': 'package main\n\nfunc main() {\n\tr := gin.Default()\n\tr.Run("localhost:8000")\n}\n',
  },
  maven: {
    'pom.xml': '<project>\n  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId></parent>\n  <properties><java.version>17</java.version></properties>\n  <dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>\n</project>\n',
    'src/main/resources/application.properties': 'server.port=8081\nspring.application.name=orders\n',
    'src/main/java/App.java': 'class App {}\n',
  },
  gradle: {
    'build.gradle.kts': 'plugins {\n  id("org.springframework.boot") version "3.3.0"\n}\njava { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\ndependencies { implementation("org.springframework.boot:spring-boot-starter-web") }\n',
    gradlew: '#!/bin/sh\n',
    'gradle/wrapper/gradle-wrapper.properties': 'x\n',
  },
  rust: {
    'Cargo.toml': '[package]\nname = "quotes"\nversion = "0.1.0"\nedition = "2021"\nrust-version = "1.80"\n\n[dependencies]\naxum = "0.7"\ntokio = { version = "1", features = ["full"] }\n',
    'Cargo.lock': 'x\n',
    'src/main.rs': 'let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();\n',
  },
  static: {
    'index.html': '<h1>Hi</h1>',
    'style.css': 'h1{}',
    'img/logo.png': 'x',
  },
  unknown: {
    'README.md': '# Notes\n',
    'notes.txt': 'x',
  },
};

const detect = async (name, files = PROJECTS[name]) => {
  const io = memIo(files);
  const scan = await scanProject(io);
  return { project: detectProject(scan, { name }), scan, io };
};

// ---- A Dockerfile's shape: instructions known, stages named before use, JSON forms valid ----
const INSTRUCTIONS = new Set(['FROM', 'RUN', 'CMD', 'LABEL', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 'ARG', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL']);
function checkDockerfile(text, label) {
  assert.ok(text.endsWith('\n'), `${label}: ends with a newline`);
  assert.doesNotMatch(text, /undefined|\[object|NaN|\$\{(?!APACHE_DOCUMENT_ROOT\})/, `${label}: nothing left unfilled`);
  assert.match(text, /^[\x09\x0a\x20-\x7e]*$/, `${label}: plain ASCII`);
  const logical = [];
  let cur = '';
  for (const raw of text.split('\n')) {
    if (!cur && (raw.startsWith('#') || !raw.trim())) continue;
    if (raw.endsWith('\\')) cur += `${raw.slice(0, -1)} `;
    else {
      logical.push(cur + raw);
      cur = '';
    }
  }
  assert.equal(cur, '', `${label}: no line continued past the end`);
  const stages = [];
  let sawFrom = false;
  let lastRunEnd = null;
  for (const line of logical) {
    const [word] = line.trim().split(/\s+/);
    assert.ok(INSTRUCTIONS.has(word), `${label}: ${word} is an instruction`);
    if (!sawFrom) assert.equal(word, 'FROM', `${label}: starts with FROM`);
    sawFrom = true;
    const rest = line.trim().slice(word.length).trim();
    if (word === 'FROM') {
      const m = /^(\S+)(?:\s+AS\s+(\S+))?$/.exec(rest);
      assert.ok(m, `${label}: FROM ${rest}`);
      assert.match(m[1], /^[a-z0-9][\w./-]*:[\w.-]+$/, `${label}: ${m[1]} is pinned to a tag`);
      if (m[2]) stages.push(m[2]);
    }
    if (word === 'COPY' || word === 'ADD') {
      const from = /--from=(\S+)/.exec(rest)?.[1];
      if (from) assert.ok(stages.includes(from) || /[:/]/.test(from), `${label}: COPY --from=${from} names an earlier stage`);
      assert.ok(rest.replace(/--\S+/g, '').trim().split(/\s+/).length >= 2, `${label}: ${word} has a source and a destination`);
    }
    if ((word === 'CMD' || word === 'ENTRYPOINT') && rest.startsWith('[')) {
      const parsed = JSON.parse(rest);
      assert.ok(Array.isArray(parsed) && parsed.every((w) => typeof w === 'string' && w), `${label}: ${word} is a list of words`);
    }
    if (word === 'EXPOSE') assert.match(rest, /^\d{2,5}$/, `${label}: EXPOSE a port`);
    if (word === 'ENV') assert.match(rest, /^(\w+=("[^"]*"|\S+)\s*)+$/, `${label}: ENV key=value pairs (${rest})`);
    if (word === 'USER') assert.notEqual(rest, 'root', `${label}: not root`);
    if (word === 'RUN') lastRunEnd = rest;
  }
  void lastRunEnd;
  assert.ok(stages.length >= 0);
  return logical;
}

// ---- A compose file's shape, without a YAML library: services, image, ports, volumes ----
function composeShape(text) {
  const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  for (const l of lines) assert.match(l, /^( {2})*\S/, `two spaces per level: ${l}`);
  assert.doesNotMatch(text, /\t/);
  const service = /^services:\n {2}([a-z0-9_-]+):$/m.exec(text)?.[1];
  assert.ok(service, 'one service');
  return {
    service,
    name: /^name: (\S+)$/m.exec(text)?.[1],
    image: /^ {4}image: (\S+)$/m.exec(text)?.[1],
    ports: [...text.matchAll(/^ {6}- "(\d+):(\d+)"$/gm)].map((m) => `${m[1]}:${m[2]}`),
    volumes: [...text.matchAll(/^ {6}- ([a-z0-9_-]+):(\/\S+)$/gm)].map((m) => m[1]),
    topVolumes: [...text.matchAll(/^ {2}([a-z0-9_-]+):$/gm)].map((m) => m[1]).filter((v) => v !== service),
    build: /^ {4}build:/m.test(text),
  };
}

let yamlLib = null;
try {
  yamlLib = (await import('js-yaml')).default;
} catch {
  // not installed here: the shape check above stands alone
}
const hasDocker = spawnSync('docker', ['--version'], { encoding: 'utf8' }).status === 0;

/** `docker compose config` reads a compose file without an engine: Docker's own check of it. */
function composeConfig(files, composePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockerize-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return spawnSync('docker', ['compose', '-f', composePath, 'config', '--format', 'json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, DOCKER_CONFIG: dir } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const planOf = (project, over = {}) => dockerPlan(project, { ...defaultOptions(project), ...over });
const fileOf = (plan, p) => plan.files.find((f) => f.path === p)?.text ?? null;

// ---- Detection, kind by kind ----

test('Node.js: an Express server, its port from the code, data folders as volumes, .env never read', async () => {
  const { project: p, io } = await detect('express');
  assert.equal(p.kind, 'node');
  assert.equal(p.what, 'Express server');
  assert.equal(p.tool, 'npm');
  assert.equal(p.version, '24', '>=20 allows the preferred version');
  assert.equal(p.start, 'node server.js');
  assert.equal(p.port, 4000);
  assert.equal(p.portFrom, 'server.js');
  assert.deepEqual(p.volumes, ['data', 'uploads']);
  assert.equal(p.env, '.env.example');
  assert.equal(p.name, 'express');
  assert.ok(!io.reads.includes('.env'), 'the real .env is never read');
  const plan = planOf(p);
  const df = fileOf(plan, 'Dockerfile');
  checkDockerfile(df, 'express');
  assert.match(df, /^FROM node:24-slim AS build$/m);
  assert.match(df, /^RUN npm ci --omit=dev$/m);
  assert.match(df, /^USER node$/m);
  assert.match(df, /^EXPOSE 4000$/m);
  assert.match(df, /^CMD \["node", "server\.js"\]$/m);
  assert.match(df, /^RUN mkdir -p \/app\/data \/app\/uploads && chown -R node /m);
  const c = composeShape(fileOf(plan, 'docker-compose.yml'));
  assert.deepEqual(c.ports, ['4000:4000']);
  assert.deepEqual(c.volumes, ['data', 'uploads']);
  assert.deepEqual(c.topVolumes, ['data', 'uploads']);
  assert.equal(c.image, 'express:latest');
  assert.ok(c.build);
  assert.match(fileOf(plan, 'docker-compose.yml'), / {4}env_file:\n {6}- path: \.env\n {8}required: false/);
  assert.match(fileOf(plan, 'docker-compose.yml'), /^ {4}restart: unless-stopped$/m);
  assert.match(fileOf(plan, 'docker-compose.yml'), /^ {4}init: true$/m);
  const ignore = fileOf(plan, '.dockerignore').split('\n');
  for (const line of ['.env', 'node_modules', '.git', 'docker/offline']) assert.ok(ignore.includes(line), `.dockerignore leaves out ${line}`);
  assert.ok(!ignore.includes('.env.example'));
});

test('Node.js: a Vite front end is built and served by nginx, from the folder vite.config names', async () => {
  const { project: p } = await detect('vite');
  assert.equal(p.kind, 'node');
  assert.equal(p.serves, 'static');
  assert.match(p.what, /^Vite, built and served by nginx/);
  assert.equal(p.out, 'public-dist');
  assert.equal(p.port, 8080);
  assert.equal(p.start, null);
  const plan = planOf(p);
  const df = fileOf(plan, 'Dockerfile');
  checkDockerfile(df, 'vite');
  assert.match(df, /^RUN npm ci$/m, 'the build needs the dev dependencies');
  assert.match(df, /^RUN npm run build$/m);
  assert.match(df, /^FROM nginxinc\/nginx-unprivileged:stable-alpine$/m);
  assert.match(df, /^COPY nginx\.conf \/etc\/nginx\/conf\.d\/default\.conf$/m);
  assert.match(df, /^COPY --from=build \/app\/public-dist \/usr\/share\/nginx\/html$/m);
  assert.match(fileOf(plan, 'nginx.conf'), /try_files \$uri \$uri\/ \/index\.html;/);
  assert.match(fileOf(plan, 'nginx.conf'), /listen 8080;/);
  assert.deepEqual(composeShape(fileOf(plan, 'docker-compose.yml')).ports, ['8080:8080']);
  assert.doesNotMatch(fileOf(plan, 'docker-compose.yml'), /init: true/, 'nginx needs no init');
  assert.ok(fileOf(plan, '.dockerignore').split('\n').includes('public-dist'));
  // A port on this computer of the person's choosing; the container's stays nginx's.
  const moved = dockerPlan(p, { ...defaultOptions(p), hostPort: '9000', port: '1234' });
  assert.deepEqual(composeShape(fileOf(moved, 'docker-compose.yml')).ports, ['9000:8080']);
  assert.match(fileOf(moved, 'Dockerfile'), /^EXPOSE 8080$/m);
});

test('Node.js: Next.js with pnpm (Corepack), the version from .nvmrc', async () => {
  const { project: p } = await detect('next');
  assert.equal(p.what, 'Next.js');
  assert.equal(p.tool, 'pnpm');
  assert.equal(p.version, '22');
  assert.equal(p.versionFrom, '.nvmrc');
  assert.equal(p.start, 'npm start');
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'next');
  assert.match(df, /^RUN npm install -g --force corepack@latest$/m);
  assert.match(df, /^COPY package\.json pnpm-lock\.yaml \.\/$/m);
  assert.match(df, /^RUN corepack pnpm install --frozen-lockfile$/m);
  assert.match(df, /^RUN corepack pnpm run build$/m);
  assert.match(df, /^RUN corepack pnpm prune --prod$/m);
  assert.match(df, /^CMD \["npm", "start"\]$/m);
  assert.ok(fileOf(planOf(p), '.dockerignore').split('\n').includes('.next'));
});

test('Node.js: NestJS with Yarn runs its built main file, on the port src/main.ts names', async () => {
  const { project: p } = await detect('nest');
  assert.equal(p.what, 'NestJS');
  assert.equal(p.tool, 'yarn');
  assert.equal(p.start, 'node dist/main');
  assert.equal(p.port, 3100);
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'nest');
  assert.match(df, /^RUN corepack yarn install --frozen-lockfile$/m);
  assert.match(df, /^RUN corepack yarn install --frozen-lockfile --production --ignore-scripts --prefer-offline$/m);
  assert.match(df, /^CMD \["node", "dist\/main"\]$/m);
});

test('Node.js: Angular’s application builder writes the pages to dist/<name>/browser', async () => {
  const { project: p } = await detect('angular');
  assert.equal(p.serves, 'static');
  assert.equal(p.out, 'dist/shop/browser');
  const plan = planOf(p);
  assert.match(fileOf(plan, 'Dockerfile'), /^COPY --from=build \/app\/dist\/shop\/browser \/usr\/share\/nginx\/html$/m);
  assert.ok(fileOf(plan, '.dockerignore').split('\n').includes('dist'));
});

test('Node.js: Bun uses its own image and words', async () => {
  const { project: p } = await detect('bun');
  assert.equal(p.tool, 'bun');
  assert.equal(p.start, 'bun run start');
  assert.equal(p.port, 8787);
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'bun');
  assert.match(df, /^FROM oven\/bun:1 AS build$/m);
  assert.match(df, /^RUN bun install --frozen-lockfile --production$/m);
  assert.match(df, /^FROM oven\/bun:1-slim$/m);
  assert.match(df, /^USER bun$/m);
  assert.doesNotMatch(df, /\bnpm\b/);
});

test('Node.js: a program without a port runs without one (no ports, no EXPOSE)', async () => {
  const { project: p } = await detect('cli');
  assert.equal(p.kind, 'node');
  assert.equal(p.port, null);
  assert.equal(p.web, false);
  assert.equal(p.start, 'node cli.js');
  const plan = planOf(p);
  assert.equal(plan.url, null);
  assert.doesNotMatch(fileOf(plan, 'Dockerfile'), /EXPOSE/);
  assert.deepEqual(composeShape(fileOf(plan, 'docker-compose.yml')).ports, []);
  assert.equal(optionProblem(p, defaultOptions(p)), '');
  // A port filled in by hand makes it served.
  const served = planOf(p, { port: '5000', hostPort: '5000' });
  assert.equal(served.url, 'http://localhost:5000');
  assert.deepEqual(composeShape(fileOf(served, 'docker-compose.yml')).ports, ['5000:5000']);
});

test('Python: FastAPI with uv, its app found in app/main.py under its own name', async () => {
  const { project: p } = await detect('fastapi');
  assert.equal(p.kind, 'python');
  assert.equal(p.what, 'FastAPI');
  assert.equal(p.tool, 'uv');
  assert.equal(p.version, '3.13', '>=3.11 allows the preferred version');
  assert.equal(p.start, 'uvicorn app.main:api --host 0.0.0.0 --port 8000');
  assert.equal(p.port, 8000);
  assert.deepEqual(p.python.extra, [], 'uvicorn is a dependency already');
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'fastapi');
  assert.match(df, /^FROM python:3\.13-slim AS build$/m);
  assert.match(df, /^RUN uv sync --frozen --no-dev --no-install-project$/m);
  assert.match(df, /^RUN useradd --create-home --uid 10001 app$/m);
  assert.match(df, /^CMD \["uvicorn", "app\.main:api", "--host", "0\.0\.0\.0", "--port", "8000"\]$/m);
});

test('Python: Flask with pip gets gunicorn, the version from .python-version', async () => {
  const { project: p } = await detect('flask');
  assert.equal(p.what, 'Flask');
  assert.equal(p.tool, 'pip');
  assert.equal(p.version, '3.11');
  assert.deepEqual(p.python.extra, ['gunicorn']);
  assert.equal(p.start, 'gunicorn --bind 0.0.0.0:8000 app:app');
  assert.deepEqual(p.volumes, ['instance'], 'Flask keeps its SQLite file in instance/');
  assert.ok(p.notes.some((n) => /gunicorn is not in the project’s dependencies/.test(n)));
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'flask');
  assert.match(df, /^RUN pip install -r requirements\.txt$/m);
  assert.match(df, /^RUN pip install gunicorn$/m);
  assert.match(df, /^FROM python:3\.11-slim$/m);
});

test('Python: a Flask app factory runs through gunicorn’s factory call', async () => {
  const { project: p } = await detect('factory');
  assert.equal(p.start, "gunicorn --bind 0.0.0.0:8000 'app:create_app()'");
  assert.deepEqual(p.python.extra, []);
  assert.match(fileOf(planOf(p), 'Dockerfile'), /^CMD \["gunicorn", "--bind", "0\.0\.0\.0:8000", "app:create_app\(\)"\]$/m);
});

test('Python: Django with Poetry wins over a package.json that only builds styles', async () => {
  const { project: p } = await detect('django');
  assert.equal(p.kind, 'python');
  assert.equal(p.what, 'Django');
  assert.equal(p.tool, 'poetry');
  assert.equal(p.start, 'gunicorn --bind 0.0.0.0:8000 mysite.wsgi');
  assert.deepEqual(p.volumes, ['media']);
  assert.ok(p.notes.some((n) => /ALLOWED_HOSTS/.test(n)));
  assert.ok(p.notes.some((n) => /psycopg2 is built from source/.test(n)));
  assert.ok(p.notes.some((n) => /db\.sqlite3 is in the project’s top folder/.test(n)));
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'django');
  assert.match(df, /^RUN poetry install --only main --no-root$/m);
  assert.match(df, /^COPY pyproject\.toml poetry\.lock \.\/$/m);
});

test('Python: a plain script runs with python, without a port', async () => {
  const { project: p } = await detect('script');
  assert.equal(p.what, 'a Python app');
  assert.equal(p.start, 'python main.py');
  assert.equal(p.port, null);
  assert.equal(p.init, true);
  assert.doesNotMatch(fileOf(planOf(p), 'Dockerfile'), /EXPOSE/);
});

test('Python: Streamlit listens on all addresses, on its own port', async () => {
  const { project: p } = await detect('streamlit');
  assert.equal(p.start, 'streamlit run app.py --server.address=0.0.0.0 --server.port=8501');
  assert.equal(p.port, 8501);
});

test('PHP: Laravel with Apache on 8080, its extensions, its front end built, storage kept', async () => {
  const { project: p } = await detect('laravel');
  assert.equal(p.kind, 'php');
  assert.equal(p.what, 'Laravel, with Apache');
  assert.equal(p.version, '8.4');
  assert.deepEqual(p.php.exts, ['gd', 'intl'], 'mbstring comes with PHP');
  assert.deepEqual(p.volumes, ['storage']);
  assert.equal(p.init, false);
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'laravel');
  assert.match(df, /^FROM composer:2 AS vendor$/m);
  assert.match(df, /^FROM node:24-slim AS assets$/m);
  assert.match(df, /^FROM php:8\.4-apache$/m);
  assert.match(df, /^RUN install-php-extensions gd intl$/m);
  assert.match(df, /^ENV APACHE_DOCUMENT_ROOT=\/var\/www\/html\/public$/m);
  assert.match(df, /Listen 8080/);
  assert.match(df, /^USER www-data$/m);
  assert.match(df, /^COPY --from=vendor --chown=www-data:www-data \/app\/vendor \.\/vendor$/m);
  assert.match(df, /^COPY --from=assets --chown=www-data:www-data \/app\/public \.\/public$/m);
  assert.doesNotMatch(df, /^CMD/m, 'the image starts Apache by itself');
  assert.deepEqual(composeShape(fileOf(planOf(p), 'docker-compose.yml')).ports, ['8080:8080']);
});

test('PHP: plain files are served as they are', async () => {
  const { project: p } = await detect('php');
  assert.equal(p.what, 'PHP, served by Apache');
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'php');
  assert.doesNotMatch(df, /composer/);
  assert.doesNotMatch(df, /APACHE_DOCUMENT_ROOT/);
});

test('.NET: an ASP.NET Core project is published with the SDK and runs on the runtime', async () => {
  const { project: p } = await detect('dotnet');
  assert.equal(p.kind, 'dotnet');
  assert.equal(p.version, '8.0');
  assert.equal(p.port, 8080);
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'dotnet');
  assert.match(df, /^FROM mcr\.microsoft\.com\/dotnet\/sdk:8\.0 AS build$/m);
  assert.match(df, /^RUN dotnet publish "Api\.csproj" -c Release -o \/app\/publish -p:UseAppHost=false$/m);
  assert.match(df, /^FROM mcr\.microsoft\.com\/dotnet\/aspnet:8\.0$/m);
  assert.match(df, /^ENTRYPOINT \["dotnet", "Api\.dll"\]$/m);
  assert.match(df, /^USER app$/m);
});

test('.NET: a solution’s web project is the one published, the newest framework it targets', async () => {
  const { project: p } = await detect('solution');
  assert.equal(p.dotnet.project, 'src/Shop.Web/Shop.Web.csproj');
  assert.equal(p.version, '9.0');
  assert.match(fileOf(planOf(p), 'Dockerfile'), /^ENTRYPOINT \["dotnet", "ShopWeb\.dll"\]$/m);
});

test('.NET Framework is said to need Windows containers', async () => {
  const { project: p } = await detect('framework');
  assert.equal(p.kind, 'unknown');
  assert.match(p.reason, /only on Windows/);
});

test('Go: the program in cmd/ named like the module, static on Alpine', async () => {
  const { project: p } = await detect('go');
  assert.equal(p.kind, 'go');
  assert.equal(p.version, '1.22');
  assert.equal(p.go.pkg, './cmd/inventory');
  assert.equal(p.port, 9090);
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'go');
  assert.match(df, /^FROM golang:1\.22-alpine AS build$/m);
  assert.match(df, /^COPY go\.mod go\.sum \.\/$/m);
  assert.match(df, /^RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o \/out\/app \.\/cmd\/inventory$/m);
  assert.match(df, /^FROM alpine:3\.22$/m);
  assert.match(df, /^COPY --from=build \/src\/templates \.\/templates$/m);
});

test('Go: go-sqlite3 needs CGO, on Debian; the toolchain line wins; localhost is pointed out', async () => {
  const { project: p } = await detect('gocgo');
  assert.equal(p.version, '1.24');
  assert.equal(p.go.cgo, true);
  assert.equal(p.port, 8000);
  assert.ok(p.notes.some((n) => /this computer only/.test(n)));
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'gocgo');
  assert.match(df, /^FROM golang:1\.24-bookworm AS build$/m);
  assert.match(df, /^FROM debian:bookworm-slim$/m);
  assert.doesNotMatch(df, /go\.sum/);
});

test('Java: Spring Boot with Maven, the version and port from the project', async () => {
  const { project: p } = await detect('maven');
  assert.equal(p.kind, 'java');
  assert.equal(p.version, '17');
  assert.equal(p.port, 8081);
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'maven');
  assert.match(df, /^FROM maven:3\.9-eclipse-temurin-17 AS build$/m);
  assert.match(df, /^FROM eclipse-temurin:17-jre$/m);
  assert.match(df, /^ENTRYPOINT \["java", "-jar", "app\.jar"\]$/m);
});

test('Java: Spring Boot with the Gradle wrapper builds its boot jar', async () => {
  const { project: p } = await detect('gradle');
  assert.equal(p.version, '21');
  assert.equal(p.java.wrapper, true);
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'gradle');
  assert.match(df, /^FROM eclipse-temurin:21-jdk AS build$/m);
  assert.match(df, /\.\/gradlew bootJar --no-daemon/);
});

test('Rust: an axum server, its binary and port, on Debian slim', async () => {
  const { project: p } = await detect('rust');
  assert.equal(p.kind, 'rust');
  assert.equal(p.version, '1.80');
  assert.equal(p.port, 3000);
  const df = fileOf(planOf(p), 'Dockerfile');
  checkDockerfile(df, 'rust');
  assert.match(df, /^FROM rust:1\.80-slim-bookworm AS build$/m);
  assert.match(df, /cargo build --release --locked && cp target\/release\/quotes \/app$/m);
  assert.match(df, /^FROM debian:bookworm-slim$/m);
});

test('A static website is served by nginx as it is', async () => {
  const { project: p } = await detect('static');
  assert.equal(p.kind, 'static');
  assert.equal(p.port, 8080);
  const plan = planOf(p);
  const df = fileOf(plan, 'Dockerfile');
  checkDockerfile(df, 'static');
  assert.match(df, /^COPY \. \/usr\/share\/nginx\/html$/m);
  assert.equal(fileOf(plan, 'nginx.conf'), null, 'a plain site needs no nginx.conf');
});

test('An unknown folder says which files were looked for', async () => {
  const { project: p } = await detect('unknown');
  assert.equal(p.kind, 'unknown');
  assert.match(p.reason, /package\.json/);
});

// ---- The files, every kind ----

const KNOWN = Object.keys(PROJECTS).filter((k) => !['unknown', 'framework'].includes(k));

test('every kind: Dockerfiles well formed, compose files that parse, in both places, offline too', async () => {
  for (const name of KNOWN) {
    const { project: p } = await detect(name);
    for (const location of ['root', 'docker']) {
      const plan = planOf(p, { location, offline: true });
      const label = `${name} (${location})`;
      const df = fileOf(plan, plan.dockerfile);
      checkDockerfile(df, label);
      assert.equal(plan.dockerfile, location === 'docker' ? 'docker/Dockerfile' : 'Dockerfile');
      for (const f of plan.files) {
        assert.ok(!f.path.startsWith('/') && !f.path.includes('..'), `${label}: ${f.path} is inside the project`);
        assert.ok(f.text.endsWith('\n'), `${label}: ${f.path} ends with a newline`);
        assert.doesNotMatch(f.text, /undefined|\[object|NaN/, `${label}: ${f.path} has nothing left unfilled`);
        if (!f.path.endsWith('.md')) assert.match(f.text, /^[\x09\x0a\x20-\x7e]*$/, `${label}: ${f.path} is plain ASCII (Windows PowerShell reads scripts as ANSI)`);
      }
      for (const compose of [plan.compose, 'docker/offline/compose.yml']) {
        const text = fileOf(plan, compose);
        const c = composeShape(text);
        assert.equal(c.name, p.name);
        assert.equal(c.image, `${p.name}:latest`);
        assert.equal(c.build, compose === plan.compose, `${label}: ${compose} builds only when not offline`);
        if (yamlLib) {
          const doc = yamlLib.load(text);
          const svc = doc.services[p.name];
          assert.equal(svc.image, `${p.name}:latest`);
          assert.equal(svc.restart, 'unless-stopped');
          if (compose.includes('offline')) assert.equal(svc.pull_policy, 'never');
          if (location === 'docker' && !compose.includes('offline')) assert.deepEqual(svc.build, { context: '..', dockerfile: 'docker/Dockerfile' });
        }
      }
      if (location === 'docker') {
        const ignore = fileOf(plan, 'docker/Dockerfile.dockerignore');
        assert.ok(ignore, `${label}: the ignore file next to its Dockerfile`);
        for (const line of ['docker/Dockerfile*', 'docker/*compose*.yml', 'docker/DOCKER.md', 'docker/offline']) assert.ok(ignore.split('\n').includes(line), `${label}: Dockerize's own files stay out of the image (${line})`);
        assert.ok(!ignore.split('\n').includes('docker/nginx.conf'), `${label}: nginx.conf is copied in`);
        assert.equal(fileOf(plan, '.dockerignore'), null);
        if (fileOf(plan, 'docker/nginx.conf')) assert.match(df, /^COPY docker\/nginx\.conf /m);
      }
    }
  }
});

test('docker compose itself reads every compose file (when Docker is installed)', { skip: !hasDocker && 'no docker here' }, async () => {
  for (const name of KNOWN) {
    const { project: p } = await detect(name);
    for (const location of ['root', 'docker']) {
      const plan = planOf(p, { location, offline: true });
      const files = Object.fromEntries(plan.files.map((f) => [f.path, f.text]));
      for (const compose of [plan.compose, 'docker/offline/compose.yml']) {
        const r = composeConfig(files, compose);
        assert.equal(r.status, 0, `${name} (${location}) ${compose}: ${r.stderr}`);
        const config = JSON.parse(r.stdout);
        const svc = config.services[p.name];
        assert.ok(svc, `${name}: the service is there`);
        assert.equal(config.name, p.name);
        if (servesPort(p, defaultOptions(p))) assert.equal(String(svc.ports[0].published), String(defaultOptions(p).hostPort));
        if (!compose.includes('offline')) assert.ok(svc.build.dockerfile.endsWith('Dockerfile'));
      }
    }
  }
});

test('the install scripts are valid sh (sh -n) and name the image and the address', async () => {
  const { project: p } = await detect('express');
  const plan = planOf(p, { offline: true, hostPort: '8088' });
  const sh = fileOf(plan, 'docker/offline/install.sh');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockerize-sh-'));
  try {
    fs.writeFileSync(path.join(dir, 'install.sh'), sh);
    execFileSync('sh', ['-n', path.join(dir, 'install.sh')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.match(sh, /^#!\/bin\/sh$/m);
  assert.match(sh, /ls -t express\.tar\.gz express\.tar/);
  assert.match(sh, /docker load --input "\$image"/);
  assert.match(sh, /docker compose --file compose\.yml up --detach/);
  assert.match(sh, /http:\/\/localhost:8088/);
  const ps = fileOf(plan, 'docker/offline/install.ps1');
  assert.match(ps, /Get-ChildItem -Path 'express\.tar\.gz', 'express\.tar'/);
  assert.match(ps, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/);
  assert.match(ps, /Set-Location -LiteralPath \$PSScriptRoot/);
  assert.match(fileOf(plan, 'docker/offline/.gitignore'), /^\*\.tar\.gz$/m);
  assert.match(fileOf(plan, 'docker/offline/README.txt'), /sh install\.sh/);
  assert.match(fileOf(plan, 'docker/offline/compose.yml'), /^ {4}platform: linux\/amd64$/m);
  assert.ok(planOf(p).files.every((f) => !f.path.startsWith('docker/offline/')), 'no offline files unless asked');
});

test('the offline package is built per shell: buildx for a platform, compose for this computer’s', async () => {
  const { project: p } = await detect('express');
  const plan = planOf(p, { offline: true });
  assert.equal(
    offlineBuildLine(plan, 'posix'),
    'docker buildx build --platform linux/amd64 --tag express:latest --load --file Dockerfile . && cp -f .env.example docker/offline/.env.example && docker save express:latest | gzip > docker/offline/express.tar.gz && echo "The offline package is ready: docker/offline"',
  );
  assert.match(offlineBuildLine(plan, 'powershell'), /^docker buildx build .*; if \(\$LASTEXITCODE -eq 0\) \{ Copy-Item -Force \.env\.example docker\/offline\/\.env\.example; docker save --output docker\/offline\/express\.tar express:latest \}/);
  assert.doesNotMatch(offlineBuildLine(plan, 'powershell'), /gzip|&&/, 'Windows PowerShell has neither');
  assert.match(offlineBuildLine(plan, 'cmd'), /copy \/Y \.env\.example docker\\offline\\\.env\.example >nul && docker save --output docker\/offline\/express\.tar express:latest/);
  const arm = planOf(p, { offline: true, platform: 'linux/arm64', location: 'docker' });
  assert.match(offlineBuildLine(arm, 'posix'), /^docker buildx build --platform linux\/arm64 --tag express:latest --load --file docker\/Dockerfile \. && /);
  const here = planOf(p, { offline: true, platform: 'native', location: 'docker' });
  assert.match(offlineBuildLine(here, 'wsl'), /^docker compose -f docker\/docker-compose\.yml build && /);
  assert.doesNotMatch(fileOf(here, 'docker/offline/compose.yml'), /platform:/);
  // A project whose settings live only in .env: that file (passwords) is never copied.
  const own = { ...PROJECTS.express };
  delete own['.env.example'];
  const { project: q } = await detect('express', own);
  assert.equal(q.env, '.env');
  assert.doesNotMatch(offlineBuildLine(planOf(q, { offline: true }), 'posix'), /\.env/);
});

test('an existing compose file’s name is kept (docker compose reads compose.yaml first)', async () => {
  const { project: p, scan } = await detect('express', { ...PROJECTS.express, 'compose.yaml': 'services: {}\n' });
  assert.ok(scan.texts['compose.yaml'] !== undefined, 'read, to show how it differs');
  const plan = dockerPlan(p, defaultOptions(p), { composeName: 'compose.yaml' });
  assert.equal(plan.compose, 'compose.yaml');
  assert.ok(fileOf(plan, 'compose.yaml'));
  assert.equal(plan.up, 'docker compose up -d --build');
  const inDocker = dockerPlan(p, { ...defaultOptions(p), location: 'docker' }, { composeName: 'compose.yaml' });
  assert.equal(inDocker.compose, 'docker/docker-compose.yml');
  assert.equal(inDocker.up, 'docker compose -f docker/docker-compose.yml up -d --build');
});

test('DOCKER.md: install on each system, the commands, the offline steps, the notes', async () => {
  const { project: p } = await detect('django');
  const md = fileOf(planOf(p, { offline: true }), 'DOCKER.md');
  for (const words of ['Windows 10 or 11', 'Docker Desktop', 'winget install', 'brew install --cask docker', 'get.docker.com', 'docker compose up -d --build', 'docker compose logs -f', 'docker compose down', 'install.ps1', 'sh install.sh', 'WSL 2', 'systemctl enable docker', 'ALLOWED_HOSTS', 'download.docker.com']) assert.ok(md.includes(words), `DOCKER.md says ${words}`);
  assert.match(md, /`media\/`/);
  const plain = fileOf(planOf(p), 'DOCKER.md');
  assert.match(plain, /tick \*\*Make it installable offline\*\*/);
  assert.doesNotMatch(plain, /install\.ps1/);
});

test('the review question names the files', async () => {
  const { project: p } = await detect('express');
  assert.match(reviewQuestion(planOf(p)), /Dockerfile, docker-compose\.yml, \.dockerignore, DOCKER\.md/);
});

// ---- The small parts ----

test('versions from constraints: npm, PEP 440, Composer, Poetry', () => {
  const node = VERSIONS.node;
  assert.equal(pickVersion('>=18', node), '24');
  assert.equal(pickVersion('^20.11.0', node), '20');
  assert.equal(pickVersion('20.x', node), '20');
  assert.equal(pickVersion('18 || 20', node), '20');
  assert.equal(pickVersion('>=20 <23', node), '22');
  assert.equal(pickVersion('~22.3', node), '22');
  assert.equal(pickVersion('16', node), '16', 'an old version named outright is used');
  assert.equal(pickVersion('', node), '24');
  assert.equal(pickVersion('*', node), '24');
  const py = VERSIONS.python;
  assert.equal(pickVersion('>=3.10', py), '3.13');
  assert.equal(pickVersion('>=3.9,<3.12', py), '3.11');
  assert.equal(pickVersion('^3.10', py), '3.13');
  assert.equal(pickVersion('~3.11', py), '3.11', 'Poetry’s ~ keeps the minor');
  assert.equal(pickVersion('~=3.11', py), '3.13', 'PEP 440’s ~= keeps the major');
  assert.equal(pickVersion('==3.12.*', py), '3.12');
  const php = VERSIONS.php;
  assert.equal(pickVersion('^8.1', php), '8.4');
  assert.equal(pickVersion('~8.1', php), '8.4', 'Composer’s ~8.1 means >=8.1 <9');
  assert.equal(pickVersion('>=7.4 <8.0', php), '7.4');
  assert.equal(pickVersion('^7.4|^8.0', php), '8.4');
  assert.ok(meets('24', '>=24.1'));
  assert.ok(!meets('24', '<24'));
  assert.ok(meets('24', '<24.5'));
  assert.ok(!meets('24', '>24'));
});

test('readToml: tables, arrays across lines, inline tables, comments', () => {
  const t = readToml('# top\nname = "x"\n[project]\nrequires-python = ">=3.10" # comment\ndependencies = [\n  "a>=1",  # why\n  \'b[c]\',\n]\n[tool.poetry.dependencies]\nflask = { version = "^3", extras = ["async"] }\n[[bin]]\nname = "one"\n[[bin]]\nname = "two"\n');
  assert.equal(t[''].name, 'x');
  assert.equal(t.project['requires-python'], '>=3.10');
  assert.deepEqual(t.project.dependencies, ['a>=1', 'b[c]']);
  assert.equal(t['tool.poetry.dependencies'].flask.version, '^3');
  assert.deepEqual(t.bin.map((b) => b.name), ['one', 'two']);
  assert.deepEqual(readToml(null), { '': {} });
});

test('requirementNames, solutionProjects', () => {
  assert.deepEqual(requirementNames('Flask[async]>=3\n# x\n-r base.txt\ngit+https://x/y.git\nzope.interface==6 # pin\n'), [
    { name: 'flask', extras: ['async'] },
    { name: 'zope-interface', extras: [] },
  ]);
  assert.deepEqual(solutionProjects('Project("{X}") = "A", "src\\A\\A.csproj", "{1}"\nProject("{X}") = "B", "..\\B\\B.csproj", "{2}"'), ['src/A/A.csproj']);
  assert.deepEqual(solutionProjects('<Solution><Project Path="src/Web/Web.csproj" /></Solution>'), ['src/Web/Web.csproj']);
});

test('splitWords and cmdLine: exec form when it can, a shell line when it must', () => {
  assert.deepEqual(splitWords('node server.js'), ['node', 'server.js']);
  assert.deepEqual(splitWords("gunicorn 'app:create_app()'"), ['gunicorn', 'app:create_app()']);
  assert.deepEqual(splitWords('node "my app.js"'), ['node', 'my app.js']);
  assert.equal(splitWords('npm run build && npm start'), null);
  assert.equal(splitWords('PORT=3000 node x.js'), null);
  assert.equal(splitWords('node $ENTRY'), null);
  assert.equal(splitWords('node "$ENTRY"'), null);
  assert.equal(splitWords('python *.py'), null);
  assert.equal(cmdLine('node server.js'), 'CMD ["node", "server.js"]');
  assert.equal(cmdLine('a && b'), 'CMD a && b');
  assert.equal(cmdLine('dotnet Api.dll', 'ENTRYPOINT'), 'ENTRYPOINT ["dotnet", "Api.dll"]');
});

test('portIn and listensLocally', () => {
  assert.equal(portIn('app.listen(3000)'), 3000);
  assert.equal(portIn('const port = process.env.PORT || 8080'), 8080);
  assert.equal(portIn('os.getenv("PORT", "5000")'), 5000);
  assert.equal(portIn('uvicorn.run(app, host="0.0.0.0", port=8001)'), 8001);
  assert.equal(portIn('http.ListenAndServe(":9000", nil)'), 9000);
  assert.equal(portIn('r.Run(":7070")'), 7070);
  assert.equal(portIn('HttpServer::new(f).bind(("127.0.0.1", 8088))?'), 8088);
  assert.equal(portIn('const db = { port: 5432 }; const PORT = 4000'), 4000, 'a database’s port is not the app’s');
  assert.equal(portIn('nothing here'), null);
  // The port's variable inside a call (0.48.1): Number(…), parseInt(…, 10), int(…).
  assert.equal(portIn('await app.listen({ port: Number(process.env.PORT) || 3000, host: "0.0.0.0" })'), 3000);
  assert.equal(portIn('const port = parseInt(process.env.PORT, 10) || 4100;'), 4100);
  assert.equal(portIn('port = int(os.environ.get("PORT")) or 8000'), 8000);
  assert.equal(portIn('let listener = TcpListener::bind("0.0.0.0:8080")?;'), 8080);
  assert.ok(listensLocally("app.listen(3000, 'localhost')"));
  assert.ok(listensLocally('app.run(host="127.0.0.1")'));
  assert.ok(listensLocally('http.ListenAndServe("localhost:8080", nil)'));
  assert.ok(listensLocally('.bind(("127.0.0.1", 8080))'));
  assert.ok(!listensLocally("app.listen(3000, '0.0.0.0')"));
});

test('imageName, looksLikeProject, parentFolder', () => {
  assert.equal(imageName('My App (2)'), 'my-app-2');
  assert.equal(imageName('Café_Menu'), 'cafe-menu');
  assert.equal(imageName('...'), 'app');
  assert.equal(imageName('x'.repeat(80)).length, 50);
  assert.ok(looksLikeProject(['src', 'package.json']));
  assert.ok(looksLikeProject(['Api.csproj']));
  assert.ok(!looksLikeProject(['README.md', 'notes.txt']));
  assert.equal(parentFolder('/home/me/app'), '/home/me');
  assert.equal(parentFolder('/home'), '/');
  assert.equal(parentFolder('/'), null);
  assert.equal(parentFolder('C:\\Users\\me\\app'), 'C:\\Users\\me');
  assert.equal(parentFolder('C:\\app'), 'C:\\');
  assert.equal(parentFolder('C:\\'), null);
});

test('findProjectRoot: the nearest folder with a project file, never past what can be listed', async () => {
  const tree = {
    '/w/shop': ['package.json', 'src', '.git'],
    '/w/shop/src': ['index.js', 'lib'],
    '/w/shop/src/lib': ['util.js'],
    '/w/site/public': ['index.html'],
    '/w/site': ['README.md'],
  };
  const list = async (dir) => {
    if (!tree[dir]) throw new Error('not allowed');
    return tree[dir].map((name) => ({ name }));
  };
  assert.equal(await findProjectRoot('/w/shop/src/lib', list), '/w/shop');
  assert.equal(await findProjectRoot('/w/site/public', list), '/w/site/public', 'an index.html when nothing else is found');
  assert.equal(await findProjectRoot('/nowhere/x', list), '/nowhere/x');
});

test('optionProblem: names, ports, the start command', async () => {
  const { project: p } = await detect('express');
  const o = defaultOptions(p);
  assert.equal(optionProblem(p, o), '');
  assert.match(optionProblem(p, { ...o, name: 'My App' }), /image name/);
  assert.match(optionProblem(p, { ...o, hostPort: '70000' }), /ports/);
  assert.match(optionProblem(p, { ...o, start: ' ' }), /start command/);
  const { project: vite } = await detect('vite');
  assert.match(optionProblem(vite, { ...defaultOptions(vite), out: '../x' }), /built files/);
});

test('scanProject reads only what detection needs, and stops at its limit', async () => {
  const files = { 'package.json': '{}', 'secret.key': 'k', '.env': 'A=1', 'notes.md': 'x' };
  for (let i = 0; i < 100; i++) files[`src/f${i}.js`] = 'x';
  const io = memIo(files);
  await scanProject(io);
  assert.deepEqual(io.reads, ['package.json']);
  const many = memIo(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`P${i}.csproj`, '<Project/>'])));
  await scanProject(many, { maxReads: 10 });
  assert.equal(many.reads.length, 10);
});

// The projects CI builds and runs (scripts/docker-check.mjs, .github/workflows/docker-check.yml):
// each is detected here as it expects, so the check builds what it means to, and each gets a page
// to ask for. A Rust program serving with std's TcpListener had no port before 0.48.1.
test('the projects the Docker check builds are detected as they expect', async () => {
  for (const [name, p] of Object.entries(CHECKED)) {
    const project = detectProject(await scanProject(memIo(p.files)), { name });
    const o = { ...defaultOptions(project), ...(p.options ?? {}) };
    const plan = dockerPlan(project, o);
    const e = p.expect;
    assert.equal(project.kind, e.kind, name);
    if (e.what) assert.ok(project.what.includes(e.what), `${name}: ${project.what}`);
    for (const k of ['tool', 'version', 'start', 'serves']) if (e[k] !== undefined) assert.equal(project[k], e[k], `${name}: ${k}`);
    if (e.port !== undefined) assert.equal(project.port, e.port, `${name}: port`);
    if (e.volumes) assert.deepEqual(project.volumes, e.volumes, `${name}: volumes`);
    assert.equal(optionProblem(project, o), '', name);
    assert.ok(plan.url, `${name}: a page to ask for`);
    assert.ok(p.pages.length > 0, name);
    const ignore = plan.files.find((f) => /dockerignore$/.test(f.path)).text;
    assert.match(ignore, /^\.env$/m, `${name}: .env stays out of the image`);
  }
});
