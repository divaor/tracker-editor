// Real projects of each kind Dockerize knows, small but complete: each builds and serves a page.
// scripts/docker-check.mjs writes one to a folder, makes it ready the way its author would have
// (`prepare`: a lock file made in a container, so the machine needs nothing but Docker), runs
// what Dockerize writes for it and asks for its pages (`pages`: a path and text the answer holds).
// test/dockerize.test.js checks each is detected as `expect` says, without Docker. Not under
// test/ (node --test would run a .mjs there as a test).

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const lines = (...l) => `${l.join('\n')}\n`;
// In every project: settings with a password, which the image must leave out (.dockerignore).
const ENV = { '.env': 'CHECK_SECRET=hunter2\n' };

// Lock files, made the way each tool makes them (as the person running the check: HOME=/tmp).
const npmLock = { image: 'node:24-slim', run: 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund' };

const SPRING_APP = lines(
  'package com.example.demo;',
  '',
  'import org.springframework.boot.SpringApplication;',
  'import org.springframework.boot.autoconfigure.SpringBootApplication;',
  'import org.springframework.web.bind.annotation.GetMapping;',
  'import org.springframework.web.bind.annotation.RestController;',
  '',
  '@SpringBootApplication',
  '@RestController',
  'public class DemoApplication {',
  '    public static void main(String[] args) {',
  '        SpringApplication.run(DemoApplication.class, args);',
  '    }',
  '',
  '    @GetMapping("/")',
  '    public String hello() {',
  '        return "Hello from Spring";',
  '    }',
  '}',
);

export const PROJECTS = {
  'node-express': {
    files: {
      ...ENV,
      'package.json': json({ name: 'hello-express', version: '1.0.0', private: true, main: 'server.js', scripts: { start: 'node server.js', dev: 'node --watch server.js' }, dependencies: { express: '^4.21.2' } }),
      'server.js': lines("const express = require('express');", '', 'const app = express();', 'const port = process.env.PORT || 3000;', '', "app.get('/', (req, res) => res.send('Hello from Express'));", '', 'app.listen(port, () => console.log(`Listening on ${port}`));'),
      'data/.keep': '',
    },
    prepare: [npmLock],
    expect: { kind: 'node', what: 'Express server', port: 3000, volumes: ['data'] },
    pages: [{ path: '/', has: 'Hello from Express' }],
  },

  'node-pnpm-fastify': {
    files: {
      ...ENV,
      'package.json': json({ name: 'hello-fastify', version: '1.0.0', private: true, type: 'module', packageManager: 'pnpm@9.15.4', scripts: { start: 'node server.js' }, dependencies: { fastify: '^5.3.0' } }),
      'server.js': lines("import Fastify from 'fastify';", '', 'const app = Fastify({ logger: true });', "app.get('/', async () => ({ hello: 'fastify' }));", "await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });"),
    },
    prepare: [{ image: 'node:24-slim', run: 'npx --yes pnpm@9.15.4 install --lockfile-only' }],
    expect: { kind: 'node', what: 'Fastify server', tool: 'pnpm', port: 3000 },
    pages: [{ path: '/', has: '"hello":"fastify"' }],
  },

  'node-vite-react': {
    files: {
      ...ENV,
      'package.json': json({ name: 'hello-vite', private: true, version: '0.0.0', type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0' }, devDependencies: { '@vitejs/plugin-react': '^4.4.1', vite: '^6.3.5' } }),
      'index.html': lines('<!doctype html>', '<html lang="en">', '  <head><meta charset="UTF-8" /><title>Hello Vite</title></head>', '  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>', '</html>'),
      'vite.config.js': lines("import { defineConfig } from 'vite';", "import react from '@vitejs/plugin-react';", '', 'export default defineConfig({ plugins: [react()] });'),
      'src/main.jsx': lines("import { createRoot } from 'react-dom/client';", '', "createRoot(document.getElementById('root')).render(<h1>Hello from Vite</h1>);"),
    },
    prepare: [npmLock],
    expect: { kind: 'node', what: 'built and served by nginx', serves: 'static', port: 8080 },
    // The built page, a path the app routes itself (nginx answers it with index.html) and the script.
    pages: [{ path: '/', has: '<div id="root"></div>' }, { path: '/settings/profile', has: '<div id="root"></div>' }, { asset: /\/assets\/[\w.-]+\.js/, has: 'Hello from Vite' }],
  },

  'node-next': {
    files: {
      ...ENV,
      'package.json': json({ name: 'hello-next', version: '0.1.0', private: true, scripts: { dev: 'next dev', build: 'next build', start: 'next start' }, dependencies: { next: '^15.3.3', react: '^19.1.0', 'react-dom': '^19.1.0' } }),
      'app/layout.js': lines("export const metadata = { title: 'Hello Next' };", '', 'export default function RootLayout({ children }) {', '  return (', '    <html lang="en">', '      <body>{children}</body>', '    </html>', '  );', '}'),
      'app/page.js': lines('export default function Page() {', '  return <h1>Hello from Next</h1>;', '}'),
    },
    prepare: [npmLock],
    expect: { kind: 'node', what: 'Next.js', port: 3000 },
    pages: [{ path: '/', has: 'Hello from Next' }],
  },

  'python-flask': {
    files: {
      ...ENV,
      'requirements.txt': 'Flask>=3.1,<4\n',
      'app.py': lines('from flask import Flask', '', 'app = Flask(__name__)', '', '', '@app.get("/")', 'def hello():', '    return "Hello from Flask"', '', '', 'if __name__ == "__main__":', '    app.run(debug=True)'),
      'data/.keep': '',
    },
    // The other layout: Dockerfile and compose file in docker/, the build context the project.
    options: { location: 'docker' },
    expect: { kind: 'python', what: 'Flask', tool: 'pip', port: 8000, start: 'gunicorn --bind 0.0.0.0:8000 app:app', volumes: ['data'] },
    pages: [{ path: '/', has: 'Hello from Flask' }],
  },

  'python-fastapi-uv': {
    files: {
      ...ENV,
      'pyproject.toml': lines('[project]', 'name = "hello-fastapi"', 'version = "0.1.0"', 'requires-python = ">=3.12"', 'dependencies = [', '    "fastapi>=0.115",', '    "uvicorn[standard]>=0.34",', ']'),
      'app/__init__.py': '',
      'app/main.py': lines('from fastapi import FastAPI', '', 'app = FastAPI()', '', '', '@app.get("/")', 'def root():', '    return {"hello": "fastapi"}'),
    },
    prepare: [{ image: 'python:3.13-slim', run: 'pip install --user --quiet uv && /tmp/.local/bin/uv lock' }],
    expect: { kind: 'python', what: 'FastAPI', tool: 'uv', port: 8000, start: 'uvicorn app.main:app --host 0.0.0.0 --port 8000' },
    pages: [{ path: '/', has: '"hello":"fastapi"' }],
  },

  'python-django-poetry': {
    files: {
      ...ENV,
      'pyproject.toml': lines('[tool.poetry]', 'name = "hello-django"', 'version = "0.1.0"', 'description = ""', 'authors = ["Tester <tester@example.org>"]', 'package-mode = false', '', '[tool.poetry.dependencies]', 'python = "^3.12"', 'Django = "^5.2"', '', '[build-system]', 'requires = ["poetry-core"]', 'build-backend = "poetry.core.masonry.api"'),
      'manage.py': lines('#!/usr/bin/env python', 'import os', 'import sys', '', 'if __name__ == "__main__":', '    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")', '    from django.core.management import execute_from_command_line', '', '    execute_from_command_line(sys.argv)'),
      'mysite/__init__.py': '',
      'mysite/settings.py': lines('SECRET_KEY = "only-for-the-check"', 'DEBUG = True', 'ALLOWED_HOSTS = ["*"]', 'INSTALLED_APPS = []', 'MIDDLEWARE = []', 'ROOT_URLCONF = "mysite.urls"', 'WSGI_APPLICATION = "mysite.wsgi.application"', 'DATABASES = {}', 'USE_TZ = True'),
      'mysite/urls.py': lines('from django.http import HttpResponse', 'from django.urls import path', '', 'urlpatterns = [path("", lambda request: HttpResponse("Hello from Django"))]'),
      'mysite/wsgi.py': lines('import os', '', 'from django.core.wsgi import get_wsgi_application', '', 'os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")', 'application = get_wsgi_application()'),
    },
    prepare: [{ image: 'python:3.13-slim', run: 'pip install --user --quiet poetry && /tmp/.local/bin/poetry lock' }],
    expect: { kind: 'python', what: 'Django', tool: 'poetry', port: 8000, start: 'gunicorn --bind 0.0.0.0:8000 mysite.wsgi' },
    pages: [{ path: '/', has: 'Hello from Django' }],
  },

  'php-plain': {
    files: {
      ...ENV,
      'index.php': "<?php echo 'Hello from PHP ' . PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION;\n",
      'about.php': "<?php echo 'About';\n",
    },
    expect: { kind: 'php', port: 8080 },
    pages: [{ path: '/', has: 'Hello from PHP 8.' }, { path: '/about.php', has: 'About' }],
  },

  'php-slim-composer': {
    files: {
      ...ENV,
      'composer.json': json({ name: 'example/hello-slim', require: { php: '>=8.2', 'slim/slim': '^4.14', 'slim/psr7': '^1.7' }, autoload: { 'psr-4': { 'App\\': 'src/' } } }),
      'public/index.php': lines(
        '<?php',
        'use Psr\\Http\\Message\\ResponseInterface as Response;',
        'use Psr\\Http\\Message\\ServerRequestInterface as Request;',
        'use Slim\\Factory\\AppFactory;',
        '',
        "require __DIR__ . '/../vendor/autoload.php';",
        '',
        '$app = AppFactory::create();',
        "$app->get('/', function (Request $request, Response $response) {",
        '    $response->getBody()->write(App\\Greeting::text());',
        '    return $response;',
        '});',
        "$app->get('/hi/{name}', function (Request $request, Response $response, array $args) {",
        "    $response->getBody()->write('Hi ' . $args['name']);",
        '    return $response;',
        '});',
        '$app->run();',
      ),
      'public/.htaccess': lines('RewriteEngine On', 'RewriteCond %{REQUEST_FILENAME} !-f', 'RewriteCond %{REQUEST_FILENAME} !-d', 'RewriteRule ^ index.php [QSA,L]'),
      'src/Greeting.php': lines('<?php', 'namespace App;', '', 'final class Greeting', '{', '    public static function text(): string', '    {', "        return 'Hello from Slim';", '    }', '}'),
    },
    expect: { kind: 'php', port: 8080 },
    // A route of the app's own: Apache's document root is public/ and its .htaccess applies.
    pages: [{ path: '/', has: 'Hello from Slim' }, { path: '/hi/ana', has: 'Hi ana' }],
  },

  'dotnet-minimal': {
    files: {
      ...ENV,
      'Hello.csproj': lines('<Project Sdk="Microsoft.NET.Sdk.Web">', '  <PropertyGroup>', '    <TargetFramework>net8.0</TargetFramework>', '    <Nullable>enable</Nullable>', '    <ImplicitUsings>enable</ImplicitUsings>', '  </PropertyGroup>', '</Project>'),
      'Program.cs': lines('var app = WebApplication.CreateBuilder(args).Build();', 'app.MapGet("/", () => "Hello from .NET");', 'app.Run();'),
    },
    expect: { kind: 'dotnet' },
    pages: [{ path: '/', has: 'Hello from .NET' }],
  },

  'go-stdlib': {
    files: {
      ...ENV,
      'go.mod': 'module example.com/hello\n\ngo 1.22\n',
      'main.go': lines(
        'package main',
        '',
        'import (',
        '\t"fmt"',
        '\t"log"',
        '\t"net/http"',
        '\t"os"',
        ')',
        '',
        'func main() {',
        '\tport := os.Getenv("PORT")',
        '\tif port == "" {',
        '\t\tport = "8080"',
        '\t}',
        '\thttp.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {',
        '\t\tfmt.Fprint(w, "Hello from Go")',
        '\t})',
        '\tlog.Fatal(http.ListenAndServe(":"+port, nil))',
        '}',
      ),
    },
    options: { location: 'docker' },
    expect: { kind: 'go', port: 8080 },
    pages: [{ path: '/', has: 'Hello from Go' }],
  },

  'go-chi': {
    files: {
      ...ENV,
      'go.mod': 'module example.com/inventory\n\ngo 1.23\n\nrequire github.com/go-chi/chi/v5 v5.1.0\n',
      'cmd/inventory/main.go': lines(
        'package main',
        '',
        'import (',
        '\t"net/http"',
        '',
        '\t"github.com/go-chi/chi/v5"',
        ')',
        '',
        'func main() {',
        '\tr := chi.NewRouter()',
        '\tr.Get("/", func(w http.ResponseWriter, r *http.Request) {',
        '\t\tw.Write([]byte("Hello from chi"))',
        '\t})',
        '\tr.Get("/page", func(w http.ResponseWriter, r *http.Request) {',
        '\t\thttp.ServeFile(w, r, "templates/page.html")',
        '\t})',
        '\thttp.ListenAndServe(":9090", r)',
        '}',
      ),
      // Files the program reads at run time: copied into the image next to it.
      'templates/page.html': '<p>Hello from a template</p>\n',
    },
    prepare: [{ image: 'golang:1.24-alpine', run: 'go mod tidy', env: { GOPATH: '/tmp/go', GOCACHE: '/tmp/go-cache', GOFLAGS: '-modcacherw' } }],
    expect: { kind: 'go', port: 9090 },
    pages: [{ path: '/', has: 'Hello from chi' }, { path: '/page', has: 'Hello from a template' }],
  },

  'java-spring-maven': {
    files: {
      ...ENV,
      'pom.xml': lines(
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">',
        '  <modelVersion>4.0.0</modelVersion>',
        '  <parent>',
        '    <groupId>org.springframework.boot</groupId>',
        '    <artifactId>spring-boot-starter-parent</artifactId>',
        '    <version>3.4.5</version>',
        '    <relativePath/>',
        '  </parent>',
        '  <groupId>com.example</groupId>',
        '  <artifactId>demo</artifactId>',
        '  <version>0.0.1-SNAPSHOT</version>',
        '  <properties>',
        '    <java.version>21</java.version>',
        '  </properties>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>org.springframework.boot</groupId>',
        '      <artifactId>spring-boot-starter-web</artifactId>',
        '    </dependency>',
        '  </dependencies>',
        '  <build>',
        '    <plugins>',
        '      <plugin>',
        '        <groupId>org.springframework.boot</groupId>',
        '        <artifactId>spring-boot-maven-plugin</artifactId>',
        '      </plugin>',
        '    </plugins>',
        '  </build>',
        '</project>',
      ),
      'src/main/java/com/example/demo/DemoApplication.java': SPRING_APP,
      'src/main/resources/application.properties': 'spring.application.name=demo\n',
    },
    expect: { kind: 'java', version: '21', port: 8080 },
    pages: [{ path: '/', has: 'Hello from Spring' }],
  },

  'java-spring-gradle': {
    files: {
      ...ENV,
      'build.gradle': lines(
        'plugins {',
        "    id 'java'",
        "    id 'org.springframework.boot' version '3.4.5'",
        "    id 'io.spring.dependency-management' version '1.1.7'",
        '}',
        '',
        "group = 'com.example'",
        "version = '0.0.1-SNAPSHOT'",
        '',
        'java {',
        '    toolchain {',
        '        languageVersion = JavaLanguageVersion.of(21)',
        '    }',
        '}',
        '',
        'repositories {',
        '    mavenCentral()',
        '}',
        '',
        'dependencies {',
        "    implementation 'org.springframework.boot:spring-boot-starter-web'",
        '}',
      ),
      'settings.gradle': "rootProject.name = 'demo'\n",
      'src/main/java/com/example/demo/DemoApplication.java': SPRING_APP,
    },
    // The wrapper (gradlew and its jar), as Spring Initializr and `gradle init` give every project.
    prepare: [{ image: 'gradle:8.14-jdk21', run: 'gradle wrapper --gradle-version 8.14 --no-daemon --quiet', env: { GRADLE_USER_HOME: '/tmp/gradle' } }],
    expect: { kind: 'java', version: '21', port: 8080 },
    pages: [{ path: '/', has: 'Hello from Spring' }],
  },

  'rust-std': {
    files: {
      ...ENV,
      'Cargo.toml': lines('[package]', 'name = "hello"', 'version = "0.1.0"', 'edition = "2021"', '', '[dependencies]'),
      'Cargo.lock': lines('# This file is automatically @generated by Cargo.', '# It is not intended for manual editing.', 'version = 3', '', '[[package]]', 'name = "hello"', 'version = "0.1.0"'),
      'src/main.rs': lines(
        'use std::io::{Read, Write};',
        'use std::net::TcpListener;',
        '',
        'fn main() {',
        '    let listener = TcpListener::bind("0.0.0.0:8080").expect("the port");',
        '    for stream in listener.incoming() {',
        '        let Ok(mut stream) = stream else { continue };',
        '        let mut request = [0u8; 1024];',
        '        let _ = stream.read(&mut request);',
        '        let body = "Hello from Rust";',
        '        let _ = write!(stream, "HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n{}", body.len(), body);',
        '    }',
        '}',
      ),
    },
    expect: { kind: 'rust', port: 8080 },
    pages: [{ path: '/', has: 'Hello from Rust' }],
  },

  'rust-axum': {
    files: {
      ...ENV,
      'Cargo.toml': lines('[package]', 'name = "quotes"', 'version = "0.1.0"', 'edition = "2021"', '', '[dependencies]', 'axum = "0.8"', 'tokio = { version = "1", features = ["full"] }'),
      'src/main.rs': lines(
        'use axum::{routing::get, Router};',
        '',
        '#[tokio::main]',
        'async fn main() {',
        '    let app = Router::new().route("/", get(|| async { "Hello from axum" }));',
        '    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();',
        '    axum::serve(listener, app).await.unwrap();',
        '}',
      ),
    },
    prepare: [{ image: 'rust:1-slim', run: 'cargo generate-lockfile', env: { CARGO_HOME: '/tmp/cargo' } }],
    expect: { kind: 'rust', port: 3000 },
    pages: [{ path: '/', has: 'Hello from axum' }],
  },

  'static-site': {
    files: {
      ...ENV,
      'index.html': lines('<!doctype html>', '<html lang="en">', '  <head><meta charset="utf-8"><title>Hello</title><link rel="stylesheet" href="style.css"></head>', '  <body><h1>Hello from a static site</h1></body>', '</html>'),
      'style.css': 'h1 { color: rebeccapurple; }\n',
    },
    expect: { kind: 'static', port: 8080 },
    pages: [{ path: '/', has: 'Hello from a static site' }, { path: '/style.css', has: 'rebeccapurple' }],
  },
};
