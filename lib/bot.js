import _ from 'lodash';
import irc from 'irc';
import logger from 'winston';
import discord from 'discord.js';
import { ConfigurationError } from './errors';
import { validateChannelMapping } from './validators';
import * as emojione from 'emojione';

const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'discordEmail', 'discordPassword'];
const NICK_COLORS = ['light_blue', 'dark_blue', 'light_red', 'dark_red', 'light_green', 'dark_green',
  'magenta', 'light_magenta', 'orange', 'yellow', 'cyan', 'light_cyan'];

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - server, nickname, channelMapping, outgoingToken, incomingURL
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach(field => {
      if (!options[field]) {
        throw new ConfigurationError(`Missing configuration field ${field}`);
      }
    });

    validateChannelMapping(options.channelMapping);

    this.discord = new discord.Client();

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.discordEmail = options.discordEmail;
    this.discordPassword = options.discordPassword;
    this.commandCharacters = options.commandCharacters || [];
    this.channels = _.values(options.channelMapping);
    // Opticraft configuration
    this.ircBridgeBotNames = _.map(options.ircBridgeBotNames, name => name.toLowerCase());

    this.channelMapping = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(options.channelMapping, (ircChan, discordChan) => {
      this.channelMapping[discordChan] = ircChan.split(' ')[0].toLowerCase();
    });

    this.invertedMapping = _.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];
  }

  connect() {
    logger.debug('Connecting to IRC and Discord');
    this.discord.login(this.discordEmail, this.discordPassword);

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      ...this.ircOptions
    };

    this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  attachListeners() {
    this.discord.on('ready', () => {
      logger.debug('Connected to Discord');
    });

    this.ircClient.on('registered', message => {
      logger.debug('Registered event: ', message);
      this.autoSendCommands.forEach(element => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', error => {
      logger.error('Received error event from IRC', error);
    });

    this.discord.on('error', error => {
      logger.error('Received error event from Discord', error);
    });

    this.discord.on('message', message => {
      // Ignore bot messages and people leaving/joining
      this.sendToIRC(message);
    });

    this.ircClient.on('message', this.sendToDiscord.bind(this));

    this.ircClient.on('notice', (author, to, text) => {
      this.sendToDiscord(author, to, `*${text}*`);
    });

    this.ircClient.on('action', (author, to, text) => {
      this.sendToDiscord(author, to, `_${text}_`);
    });

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });
  }

  parseText(message) {
    const text = message.mentions.reduce((content, mention) => (
      content.replace(`<@${mention.id}>`, `@${mention.username}`)
    ), message.content);

    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/<#(\d+)>/g, (match, channelId) => {
        const channel = this.discord.channels.get('id', channelId);
        return '#' + channel.name;
      });
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }

  sendToIRC(message) {
    const author = message.author;
    // Ignore messages sent by the bot itself:
    if (author.id === this.discord.user.id) return;

    const channelName = `#${message.channel.name}`;
    const ircChannel = this.channelMapping[channelName];

    logger.debug('Channel Mapping', channelName, this.channelMapping[channelName]);
    if (ircChannel) {
      const username = author.username;
      let text = this.parseText(message);
      text = emojione.shortnameToAscii(emojione.toShort(text));

      if (this.isCommandMessage(text)) {
        const prelude = `Command sent from Discord by ${username}:`;
        this.ircClient.say(ircChannel, prelude);
        this.ircClient.say(ircChannel, text);
      } else {
        text = `<${username}> ${text}`;
        logger.debug('Sending message to IRC', ircChannel, text);
        this.ircClient.say(ircChannel, text);
      }
    }
  }

  sendToDiscord(author, channel, text) {
    const discordChannelName = this.invertedMapping[channel.toLowerCase()];
    if (discordChannelName) {
      // #channel -> channel before retrieving:
      const discordChannel = this.discord.channels.get('name', discordChannelName.slice(1));

      if (!discordChannel) {
        logger.info('Tried to send a message to a channel the bot isn\'t in: ',
          discordChannelName);
        return;
      }

      let strippedText = text;
      let strippedAuthor = author;
      const colourTokens = [];
      for (let i = 15; i >= 0; i--) {
        if (i < 10) {
          colourTokens.push("0" + i);
        }
        colourTokens.push(i);
      }

      _.forEach(colourTokens, colourToken => {
          strippedText = strippedText.replace("\u0003" + colourToken, "");
          strippedAuthor = strippedAuthor.replace("\u0003" + colourToken, "");
      })

      // Add bold formatting:
      let withAuthor = `**${strippedAuthor}:** ${strippedText}`;

      // Opticraft relay - remove username if message was from the ingame bridge
      if (_.includes(this.ircBridgeBotNames, strippedAuthor.toLowerCase())) {
          let words = strippedText.split(" ");
          let relayedAuthor = words[0];
          words.splice(0, 1);
          let message = words.join(" ");
          withAuthor = `**${relayedAuthor}** ${message}`;
      }

      logger.debug('Sending message to Discord', withAuthor, channel, '->', discordChannelName);
      this.discord.sendMessage(discordChannel, withAuthor);
    }
  }
}

export default Bot;
