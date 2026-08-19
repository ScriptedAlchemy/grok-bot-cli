# grok-bot-cli

[![npm version](https://img.shields.io/npm/v/grok-bot-cli.svg)](https://www.npmjs.com/package/grok-bot-cli)

Manage [Grok Bot](https://cursor.com/help/grok-bot/plans) agents, groups, and messages from your terminal.

![Live create, group, send, and delete smoke test](demo/grok-bot-cli-demo.gif)

[Watch the MP4](demo/grok-bot-cli-demo.mp4)

## Install

```sh
npm install --global grok-bot-cli
```

Requires Node.js 18+ and the Grok Bot macOS app. Open Grok Bot and sign in once; `gbot` automatically uses the app's encrypted session and routing credentials. No token copying is required.

## Use

```sh
gbot bots list
gbot bots create --name Researcher
gbot bots update Researcher --description "Research the launch" --notify on
gbot bots create --name Writer
gbot groups create --name Launch --member Researcher --member Writer --description "Ship together"
gbot groups update Launch --title "Launch room" --hidden off
gbot send Researcher "Summarize the launch status."
gbot send Launch "Share your updates."
gbot thread Researcher
gbot groups delete Launch
gbot bots delete Researcher
gbot bots delete Writer
```

`update` fields: `--name` `--description`/`--instructions` `--title` `--avatar-shape` `--avatar-color` `--notify` `--hidden`. `--description` is the UI Instructions field.

Run `gbot --help` for every command.

## License

MIT
