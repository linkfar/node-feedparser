/**********************************************************************
 node-feedparser - A robust RSS, Atom, RDF parser for node.
 http://github.com/danmactough/node-feedparser
 Copyright (c) 2011 Dan MacTough
 http://yabfog.com

**********************************************************************/

/**
 * Module dependencies.
 */
var sax = require('sax')
  , request = require('request')
  , fs = require('fs')
  , util = require('util')
  , EventEmitter = require('events').EventEmitter
  , utils = require('./utils')
  ;

/**
 * FeedParser constructor. Most apps will only use one instance.
 *
 * @param {Object} options
 * @api public
 */
function FeedParser (options) {
  this.options = options || {};
  if (!('strict' in this.options)) this.options.strict = false;
  if (!('normalize' in this.options)) this.options.normalize = true;
  if (!('addmeta' in this.options)) this.options.addmeta = true;
  EventEmitter.call(this);
}
util.inherits(FeedParser, EventEmitter);

FeedParser.prototype.initialize = function initialize () {
  var context = {
      options: this.options
    , meta: {
        '#ns': []
      , '@': []
      }
    , articles: []
    , stack: []
    , nodes: {}
    , xmlbase: []
    , in_xhtml: false
    , xhtml: {} /* Where to store xhtml elements as associative
                   array with keys: '#' (containing the text)
                   and '#name' (containing the XML element name) */
    , errors: []
    , callback: undefined
    , stream: sax.createStream(this.options.strict /* strict mode - no by default */, {lowercase: true, xmlns: true }) // https://github.com/isaacs/sax-js
    };
  context.stream.on('error', this.handleError.bind(context, this.handleSaxError.bind(context)));
  context.stream.on('opentag', this.handleOpenTag.bind(this, context));
  context.stream.on('closetag',this.handleCloseTag.bind(this, context));
  context.stream.on('text', this.handleText.bind(this, context));
  context.stream.on('cdata', this.handleText.bind(this, context));
  context.stream.on('end', this.handleEnd.bind(this, context));
  return context;
};

/**
 * Parses a feed contained in a string.
 *
 * For each article/post in a feed, emits an 'article' event
 * with an object with the following keys:
 *   title {String}
 *   description {String}
 *   summary {String}
 *   date {Date} (or null)
 *   pubdate {Date} (or null)
 *   link {String}
 *   origlink {String}
 *   author {String}
 *   guid {String}
 *   comments {String}
 *   image {Object}
 *   categories {Array}
 *   source {Object}
 *   enclosures {Array}
 *   meta {Object}
 *   Object.keys(meta):
 *     #ns {Array} key,value pairs of each namespace declared for the feed
 *     #type {String} one of 'atom', 'rss', 'rdf'
 *     #version {String}
 *     title {String}
 *     description {String}
 *     date {Date} (or null)
 *     pubdate {Date} (or null)
 *     link {String} i.e., to the website, not the feed
 *     xmlurl {String} the canonical URL of the feed, as declared by the feed
 *     author {String}
 *     language {String}
 *     image {Object}
 *     favicon {String}
 *     copyright {String}
 *     generator {String}
 *     categories {Array}
 *
 * Emits a 'warning' event on each XML parser warning
 *
 * Emits an 'error' event on each XML parser error
 *
 * @param {String} string of XML representing the feed
 * @param {Object} options
 * @param {Function} callback
 * @api public
 */

FeedParser.prototype.parseString = function(string, options, callback) {
  var context = this.initialize();
  options = options || {};
  if ('function' === typeof options) {
    callback = options;
    options = {};
  }
  if ('normalize' in options) context.options.normalize = options.normalize;
  if ('addmeta' in options) context.options.addmeta = options.addmeta;
  if (options.feedurl) context.xmlbase.unshift({ '#name': 'xml', '#': options.feedurl});
  if ('function' === typeof callback) context.callback = callback.bind(context);

  context.stream
    .on('error', this.handleError.bind(this, context))
    .end(string, 'utf8');
};

/**
 * Parses a feed from a file or (for compatability with libxml) a url.
 * See parseString for more info.
 *
 * @param {String} path to the feed file or a fully qualified uri or parsed url object from url.parse()
 * @param {Object} options
 * @param {Function} callback
 * @api public
 */

FeedParser.prototype.parseFile = function(file, options, callback) {
  if (/^https?:/.test(file) || ('object' === typeof file && 'protocol' in file)) {
    return this.parseUrl.apply(this, arguments);
  }

  var context = this.initialize();
  options = options || {};
  if ('function' === typeof options) {
    callback = options;
    options = {};
  }
  if ('normalize' in options) context.options.normalize = options.normalize;
  if ('addmeta' in options) context.options.addmeta = options.addmeta;
  if (options.feedurl) context.xmlbase.unshift({ '#name': 'xml', '#': options.feedurl});
  if ('function' === typeof callback) context.callback = callback.bind(context);

  fs.createReadStream(file)
    .on('error', this.handleError.bind(this, context))
    .pipe(context.stream);
};

/**
 * Parses a feed from a url.
 *
 * Please consider whether it would be better to perform conditional GETs
 * and pass in the results instead.
 *
 * See parseString for more info.
 *
 * @param {String} fully qualified uri or a parsed url object from url.parse()
 * @param {Object} options
 * @param {Function} callback
 * @api public
 */

FeedParser.prototype.parseUrl = function(url, options, callback) {
  var context = this.initialize();
  options = options || {};
  if ('function' === typeof options) {
    callback = options;
    options = {};
  }
  if ('normalize' in options) context.options.normalize = options.normalize;
  if ('addmeta' in options) context.options.addmeta = options.addmeta;

  if (!context.xmlbase.length) { // #parseFile may have already populated this value
    if (/^https?:/.test(url)) {
      context.xmlbase.unshift({ '#name': 'xml', '#': url});
    } else if (typeof url == 'object' && 'href' in url) {
      context.xmlbase.unshift({ '#name': 'xml', '#': url.href});
    }
  }
  if ('function' === typeof callback) context.callback = callback.bind(context);

  request(url)
    .on('error', this.handleError.bind(this, context))
    .pipe(context.stream);
};

/**
 * Parses a feed from a Stream.
 *
 * Example:
 *    fp = new FeedParser();
 *    fp.on('article', function (article){ // do something });
 *    fp.parseStream(fs.createReadStream('file.xml')[, callback]);
 *
 *
 * See parseString for more info.
 *
 * @param {Readable Stream}
 * @param {Object} options
 * @param {Function} callback
 * @api public
 */

FeedParser.prototype.parseStream = function(stream, options, callback) {
  var context = this.initialize();
  options = options || {};
  if ('function' === typeof options) {
    callback = options;
    options = {};
  }
  if ('normalize' in options) context.options.normalize = options.normalize;
  if ('addmeta' in options) context.options.addmeta = options.addmeta;
  if (options.feedurl) context.xmlbase.unshift({ '#name': 'xml', '#': options.feedurl});
  if ('function' === typeof callback) context.callback = callback.bind(context);

  stream
    .on('error', this.handleError.bind(this, context))
    .pipe(context.stream);
};

FeedParser.prototype.handleEnd = function (context){
  this.emit('end', context.articles);

  if ('function' === typeof context.callback) {
    if (context.errors.length) {
      var error = context.errors.pop();
      if (context.errors.length) {
        error.errors = context.errors;
      }
      context.callback(error);
    } else {
      context.callback(null, context.meta, context.articles);
    }
  }
};

FeedParser.prototype.handleSaxError = function (context){
  if (context._parser) {
    context._parser.error = null;
    context._parser.resume();
  }
};

FeedParser.prototype.handleError = function (context, next, e){
  // A SaxError will prepend an error-handling callback,
  // but other calls to #handleError will not
  if (next && !e) {
    e = next;
    next = null;
  }
  // Only emit the error event if we are not using CPS or
  // if we have a listener on 'error' even if we are using CPS
  if (!context.callback || this.listeners('error').length) {
    this.emit('error', e);
  }
  context.errors.push(e);
  if (typeof next === 'function') {
    next();
  } else {
    this.handleEnd.call(this, context);
  }
};

FeedParser.prototype.handleOpenTag = function (context, node){
  var n = {};
  n['#name'] = node.name; // Avoid namespace collissions later...
  n['#prefix'] = node.prefix; // The current ns prefix
  n['#local'] = node.local; // The current element name, sans prefix
  n['#uri'] = node.uri; // The current ns uri
  n['@'] = {};
  n['#'] = '';

  if (Object.keys(node.attributes).length) {
    n['@'] = this.handleAttributes.call(context, node.attributes, n['#name']);
  }

  if (context.in_xhtml && context.xhtml['#name'] != n['#name']) { // We are in an xhtml node
    // This builds the opening tag, e.g., <div id='foo' class='bar'>
    context.xhtml['#'] += '<'+n['#name'];
    Object.keys(n['@']).forEach(function(name){
      context.xhtml['#'] += ' '+ name +'="'+ n['@'][name] + '"';
    }, this);
    context.xhtml['#'] += '>';
  } else if ( context.stack.length === 0 &&
              (n['#name'] === 'rss' ||
              (n['#local'] === 'rdf' && utils.nslookup([n['#uri']], 'rdf')) ||
              (n['#local'] === 'feed'&& utils.nslookup([n['#uri']], 'atom')) ) ) {
    Object.keys(n['@']).forEach(function(name) {
      var o = {};
      if (name != 'version') {
        o[name] = n['@'][name];
        context.meta['@'].push(o);
      }
    }, this);
    switch(n['#local']) {
    case 'rss':
      context.meta['#type'] = 'rss';
      context.meta['#version'] = n['@']['version'];
      break;
    case 'rdf':
      context.meta['#type'] = 'rdf';
      context.meta['#version'] = n['@']['version'] || '1.0';
      break;
    case 'feed':
      context.meta['#type'] = 'atom';
      context.meta['#version'] = n['@']['version'] || '1.0';
      break;
    }
  }
  context.stack.unshift(n);
};

FeedParser.prototype.handleCloseTag = function (context, el){
  var node = { '#name' : el
             , '#prefix' : ''
             , '#local' : '' }
    , stdEl
    , item
    , baseurl
    ;
  var n = context.stack.shift();
  el = el.split(':');

  if (el.length > 1 && el[0] === n['#prefix']) {
    if (utils.nslookup(n['#uri'], 'atom')) {
      node['#prefix'] = el[0];
      node['#local'] = el.slice(1).join(':');
      node['#type'] = 'atom';
    } else if (utils.nslookup(n['#uri'], 'rdf')) {
      node['#prefix'] = el[0];
      node['#local'] = el.slice(1).join(':');
      node['#type'] = 'rdf';
    } else {
      node['#prefix'] = utils.nsprefix(n['#uri']) || n['#prefix'];
      node['#local'] = el.slice(1).join(':');
    }
  } else {
    node['#local'] = node['#name'];
    node['#type'] = utils.nsprefix(n['#uri']) || n['#prefix'];
  }
  delete n['#name'];
  delete n['#local'];
  delete n['#prefix'];
  delete n['#uri'];

  if (context.xmlbase && context.xmlbase.length) {
    baseurl = context.xmlbase[0]['#'];
  }

  if (baseurl && (node['#local'] === 'logo' || node['#local'] === 'icon') && node['#type'] === 'atom') {
    // Apply xml:base to these elements as they appear
    // rather than leaving it to the ultimate parser
    n['#'] = utils.resolve(baseurl, n['#']);
  }

  if (context.xmlbase.length && (el == context.xmlbase[0]['#name'])) {
    void context.xmlbase.shift();
  }

  if (context.in_xhtml) {
    if (node['#name'] == context.xhtml['#name']) { // The end of the XHTML

      // Add xhtml data to the container element
      n['#'] += context.xhtml['#'].trim();
        // Clear xhtml nodes from the tree
        for (var key in n) {
          if (key != '@' && key != '#') {
            delete n[key];
          }
        }
      context.xhtml = {};
      context.in_xhtml = false;
    } else { // Somewhere in the middle of the XHTML
      context.xhtml['#'] += '</' + node['#name'] + '>';
    }
  }

  if ('#' in n) {
    if (n['#'].match(/^\s*$/)) {
      // Delete text nodes with nothing by whitespace
      delete n['#'];
    } else {
      n['#'] = n['#'].trim();
      if (Object.keys(n).length === 1) {
        // If there is only one text node, hoist it
        n = n['#'];
      }
    }
  }

  if (node['#name'] === 'item' ||
      node['#name'] === 'entry' ||
      (node['#local'] === 'item' && (node['#prefix'] === '' || node['#type'] === 'rdf')) ||
      (node['#local'] == 'entry' && (node['#prefix'] === '' || node['#type'] === 'atom'))) { // We have an article!

    if (!context.meta.title) { // We haven't yet parsed all the metadata
      utils.merge(context.meta, this.handleMeta.call(context, context.stack[0], context.meta['#type'], context.options));
      this.emit('meta', context.meta);
    }
    if (!baseurl && context.xmlbase && context.xmlbase.length) { // handleMeta was able to infer a baseurl without xml:base or options.feedurl
      n = utils.reresolve(n, context.xmlbase[0]['#']);
    }
    item = this.handleItem.call(context, n, context.meta['#type'], context.options);
    if (context.options.addmeta) {
      item.meta = context.meta;
    }
    if (context.meta.author && !item.author) item.author = context.meta.author;
    this.emit('article', item);
    context.articles.push(item);
  } else if (!context.meta.title && // We haven't yet parsed all the metadata
              (node['#name'] === 'channel' ||
               node['#name'] === 'feed' ||
               (node['#local'] === 'channel' && (node['#prefix'] === '' || node['#type'] === 'rdf')) ||
               (node['#local'] === 'feed' && (node['#prefix'] === '' || node['#type'] === 'atom')) ) ) {
    utils.merge(context.meta, this.handleMeta.call(context, n, context.meta['#type'], context.options));
    this.emit('meta', context.meta);
  }

  if (context.stack.length > 0) {
    if (node['#prefix'] && node['#local'] && !node['#type']) {
      stdEl = node['#prefix'] + ':' + node['#local'];
    } else {
      stdEl = node['#local'] || node['#name'];
    }
    if (!context.stack[0].hasOwnProperty(stdEl)) {
      context.stack[0][stdEl] = n;
    } else if (context.stack[0][stdEl] instanceof Array) {
      context.stack[0][stdEl].push(n);
    } else {
      context.stack[0][stdEl] = [context.stack[0][stdEl], n];
    }
  } else {
    context.nodes = n;
  }
};

FeedParser.prototype.handleText = function (context, text){
  if (context.in_xhtml) {
    context.xhtml['#'] += text;
  } else {
    if (context.stack.length) {
      if ('#' in context.stack[0]) {
        context.stack[0]['#'] += text;
      } else {
        context.stack[0]['#'] = text;
      }
    }
  }
};

FeedParser.prototype.handleAttributes = function handleAttributes (attrs, el) {
  /*
   * Using the sax.js option { xmlns: true }
   * attrs is an array of objects (not strings) having the following properties
   * name - e.g., xmlns:dc or href
   * value
   * prefix - the first part of the name of the attribute (before the colon)
   * local - the second part of the name of the attribute (after the colon)
   * uri - the uri of the namespace
   *
   */
  var context = this;
  var basepath = ''
    , simplifiedAttributes = {}
    ;

  if (context.xmlbase && context.xmlbase.length) {
    basepath = context.xmlbase[0]['#'];
  }

  Object.keys(attrs).forEach(function(key){
    var attr = attrs[key]
      , ns = {}
      , prefix = ''
      ;
    if (attr.prefix === 'xmlns') {
      ns[attr.name] = attr.value;
      context.meta['#ns'].push(ns);
    }
    // If the feed is using a non-default prefix, we'll use it, too
    // But we force the use of the 'xml' prefix
    if (attr.uri && attr.prefix && !utils.nslookup(attr.uri, attr.prefix) || utils.nslookup(attr.uri, 'xml')) {
      prefix = ( utils.nsprefix(attr.uri) || attr.prefix ) + ( attr.local ? ':' : '' );
    }
    if (basepath && (attr.local == 'href' || attr.local == 'src' || attr.local == 'uri')) {
      // Apply xml:base to these elements as they appear
      // rather than leaving it to the ultimate parser
      attr.value = utils.resolve(basepath, attr.value);
    } else if (attr.local === 'base' && utils.nslookup(attr.uri, 'xml')) {
      // Keep track of the xml:base for the current node
      if (basepath) {
        attr.value = utils.resolve(basepath, attr.value);
      }
      context.xmlbase.unshift({ '#name': el, '#': attr.value});
    } else if (attr.name === 'type' && attr.value === 'xhtml') {
      context.in_xhtml = true;
      context.xhtml = {'#name': el, '#': ''};
    }
    simplifiedAttributes[prefix + attr.local] = attr.value ? attr.value.trim() : '';
  }, this);
  return simplifiedAttributes;
};

FeedParser.prototype.handleMeta = function handleMeta (node, type, options) {
  if (!type || !node) return {};

  var context = this;
  var meta = {}
    , normalize = !options || (options && options.normalize)
    ;

  if (normalize) {
    ['title','description','date', 'pubdate', 'pubDate','link', 'xmlurl', 'xmlUrl','author','language','favicon','copyright','generator'].forEach(function (property){
      meta[property] = null;
    });
    meta.image = {};
    meta.categories = [];
  }

  Object.keys(node).forEach(function(name){
    var el = node[name];

    if (normalize) {
      switch(name){
      case('title'):
        meta.title = utils.get(el);
        break;
      case('description'):
      case('subtitle'):
        meta.description = utils.get(el);
        break;
      case('pubdate'):
      case('lastbuilddate'):
      case('published'):
      case('modified'):
      case('updated'):
      case('dc:date'):
        var date = utils.get(el) ? new Date(el['#']) : null;
        if (!date) break;
        if (meta.pubdate === null || name == 'pubdate' || name == 'published')
          meta.pubdate = meta.pubDate = date;
        if (meta.date === null || name == 'lastbuilddate' || name == 'modified' || name == 'updated')
          meta.date = date;
        break;
      case('link'):
      case('atom:link'):
      case('atom10:link'):
        if (Array.isArray(el)) {
          el.forEach(function (link){
            if (link['@']['href']) { // Atom
              if (utils.get(link['@'], 'rel')) {
                if (link['@']['rel'] == 'alternate') meta.link = link['@']['href'];
                else if (link['@']['rel'] == 'self') {
                  meta.xmlurl = meta.xmlUrl = link['@']['href'];
                  if (context.xmlbase && context.xmlbase.length === 0) {
                    context.xmlbase.unshift({ '#name': 'xml', '#': meta.xmlurl});
                    context.stack[0] = utils.reresolve(context.stack[0], meta.xmlurl);
                  }
                }
              } else {
                meta.link = link['@']['href'];
              }
            } else if (Object.keys(link['@']).length === 0) { // RSS
              if (!meta.link) meta.link = utils.get(link);
            }
          }, this);
        } else {
          if (el['@']['href']) { // Atom
            if (utils.get(el['@'], 'rel')) {
              if (el['@']['rel'] == 'alternate') meta.link = el['@']['href'];
              else if (el['@']['rel'] == 'self') {
                meta.xmlurl = meta.xmlUrl = el['@']['href'];
                if (context.xmlbase && context.xmlbase.length === 0) {
                  context.xmlbase.unshift({ '#name': 'xml', '#': meta.xmlurl});
                  context.stack[0] = utils.reresolve(context.stack[0], meta.xmlurl);
                }
              }
            } else {
              meta.link = el['@']['href'];
            }
          } else if (Object.keys(el['@']).length === 0) { // RSS
            if (!meta.link) meta.link = utils.get(el);
          }
        }
        break;
      case('managingeditor'):
      case('webmaster'):
      case('author'):
        if (meta.author === null || name == 'managingeditor')
          meta.author = utils.get(el);
        if (name == 'author')
          meta.author = utils.get(el.name) || utils.get(el.email) || utils.get(el.uri);
        break;
      case('language'):
        meta.language = utils.get(el);
        break;
      case('image'):
      case('logo'):
        if (el.url)
          meta.image.url = utils.get(el.url);
        if (el.title)
          meta.image.title = utils.get(el.title);
        else meta.image.url = utils.get(el);
        break;
      case('icon'):
        meta.favicon = utils.get(el);
        break;
      case('copyright'):
      case('rights'):
      case('dc:rights'):
        meta.copyright = utils.get(el);
        break;
      case('generator'):
        meta.generator = utils.get(el);
        if (utils.get(el['@'], 'version'))
          meta.generator += (meta.generator ? ' ' : '') + 'v' + el['@'].version;
        if (utils.get(el['@'], 'uri'))
          meta.generator += meta.generator ? ' (' + el['@'].uri + ')' : el['@'].uri;
        break;
      case('category'):
      case('dc:subject'):
      case('itunes:category'):
      case('media:category'):
        /* We handle all the kinds of categories within the switch loop because meta.categories
         * is an array, unlike the other properties, and therefore can handle multiple values
         */
        var _category = ''
          , _categories = []
          ;
        if (Array.isArray(el)) {
          el.forEach(function (category){
            if ('category' == name && 'atom' == type) {
              if (category['@'] && utils.get(category['@'], 'term')) meta.categories.push(utils.get(category['@'], 'term'));
            } else if ('category' == name && utils.get(category) && 'rss' == type) {
              _categories = utils.get(category).split(',').map(function (cat){ return cat.trim(); });
              if (_categories.length) meta.categories = meta.categories.concat(_categories);
            } else if ('dc:subject' == name && utils.get(category)) {
              _categories = utils.get(category).split(' ').map(function (cat){ return cat.trim(); });
              if (_categories.length) meta.categories = meta.categories.concat(_categories);
            } else if ('itunes:category' == name) {
              if (category['@'] && utils.get(category['@'], 'text')) _category = utils.get(category['@'], 'text');
              if (category[name]) {
                if (Array.isArray(category[name])) {
                  category[name].forEach(function (subcategory){
                    if (subcategory['@'] && utils.get(subcategory['@'], 'text')) meta.categories.push(_category + '/' + utils.get(subcategory['@'], 'text'));
                  });
                } else {
                  if (category[name]['@'] && utils.get(category[name]['@'], 'text'))
                    meta.categories.push(_category + '/' + utils.get(category[name]['@'], 'text'));
                }
              } else {
                meta.categories.push(_category);
              }
            } else if ('media:category' == name) {
              meta.categories.push(utils.get(category));
            }
          });
        } else {
          if ('category' == name && 'atom' == type) {
            if (utils.get(el['@'], 'term')) meta.categories.push(utils.get(el['@'], 'term'));
          } else if ('category' == name && utils.get(el) && 'rss' == type) {
            _categories = utils.get(el).split(',').map(function (cat){ return cat.trim(); });
            if (_categories.length) meta.categories = meta.categories.concat(_categories);
          } else if ('dc:subject' == name && utils.get(el)) {
            _categories = utils.get(el).split(' ').map(function (cat){ return cat.trim(); });
            if (_categories.length) meta.categories = meta.categories.concat(_categories);
          } else if ('itunes:category' == name) {
            if (el['@'] && utils.get(el['@'], 'text')) _category = utils.get(el['@'], 'text');
            if (el[name]) {
              if (Array.isArray(el[name])) {
                el[name].forEach(function (subcategory){
                  if (subcategory['@'] && utils.get(subcategory['@'], 'text')) meta.categories.push(_category + '/' + utils.get(subcategory['@'], 'text'));
                });
              } else {
                if (el[name]['@'] && utils.get(el[name]['@'], 'text'))
                  meta.categories.push(_category + '/' + utils.get(el[name]['@'], 'text'));
              }
            } else {
              meta.categories.push(_category);
            }
          } else if ('media:category' == name) {
            meta.categories.push(utils.get(el));
          }
        }
        break;
      } // switch end
    }
    // Fill with all native other namespaced properties
    if (name.indexOf('#') !== 0) {
      if (~name.indexOf(':')) meta[name] = el;
      else meta[type + ':' + name] = el;
    }
  }, this); // forEach end

  if (normalize) {
    if (!meta.description) {
      if (node['itunes:summary']) meta.description = utils.get(node['itunes:summary']);
      else if (node['tagline']) meta.description = utils.get(node['tagline']);
    }
    if (!meta.author) {
      if (node['itunes:author']) meta.author = utils.get(node['itunes:author']);
      else if (node['itunes:owner'] && node['itunes:owner']['itunes:name']) meta.author = utils.get(node['itunes:owner']['itunes:name']);
      else if (node['dc:creator']) meta.author = utils.get(node['dc:creator']);
      else if (node['dc:publisher']) meta.author = utils.get(node['dc:publisher']);
    }
    if (!meta.language) {
      if (node['@'] && node['@']['xml:lang']) meta.language = utils.get(node['@'], 'xml:lang');
      else if (node['dc:language']) meta.language = utils.get(node['dc:language']);
    }
    if (!meta.image.url) {
      if (node['itunes:image']) meta.image.url = utils.get(node['itunes:image']['@'], 'href');
      else if (node['media:thumbnail']) meta.image.url = utils.get(node['media:thumbnail']['@'], 'url');
    }
    if (!meta.copyright) {
      if (node['media:copyright']) meta.copyright = utils.get(node['media:copyright']);
      else if (node['dc:rights']) meta.copyright = utils.get(node['dc:rights']);
      else if (node['creativecommons:license']) meta.copyright = utils.get(node['creativecommons:license']);
      else if (node['cc:license']) {
        if (Array.isArray(node['cc:license']) && node['cc:license'][0]['@'] && node['cc:license'][0]['@']['rdf:resource']) {
          meta.copyright = utils.get(node['cc:license'][0]['@'], 'rdf:resource');
        } else if (node['cc:license']['@'] && node['cc:license']['@']['rdf:resource']) {
          meta.copyright = utils.get(node['cc:license']['@'], 'rdf:resource');
        }
      }
    }
    if (!meta.generator) {
      if (node['admin:generatoragent']) {
        if (Array.isArray(node['admin:generatoragent']) && node['admin:generatoragent'][0]['@'] && node['admin:generatoragent'][0]['@']['rdf:resource']) {
          meta.generator = utils.get(node['admin:generatoragent'][0]['@'], 'rdf:resource');
        } else if (node['admin:generatoragent']['@'] && node['admin:generatoragent']['@']['rdf:resource']) {
          meta.generator = utils.get(node['admin:generatoragent']['@'], 'rdf:resource');
        }
      }
    }
    if (meta.categories.length)
      meta.categories = utils.unique(meta.categories);
  }
  return meta;
};

FeedParser.prototype.handleItem = function handleItem (node, type, options){
  if (!type || !node) return {};

  var context = this;
  var item = {}
    , normalize = !options || (options && options.normalize)
    ;

  if (normalize) {
    ['title','description','summary','date','pubdate','pubDate','link','guid','author','comments', 'origlink'].forEach(function (property){
      item[property] = null;
    });
    item.image = {};
    item.source = {};
    item.categories = [];
    item.enclosures = [];
  }

  Object.keys(node).forEach(function(name){
    var el = node[name];
    if (normalize) {
      switch(name){
      case('title'):
        item.title = utils.get(el);
        break;
      case('description'):
      case('summary'):
        item.summary = utils.get(el);
        if (!item.description) item.description = utils.get(el);
        break;
      case('content'):
      case('content:encoded'):
        item.description = utils.get(el);
        break;
      case('pubdate'):
      case('published'):
      case('issued'):
      case('modified'):
      case('updated'):
      case('dc:date'):
        var date = utils.get(el) ? new Date(el['#']) : null;
        if (!date) break;
        if (item.pubdate === null || name == 'pubdate' || name == 'published' || name == 'issued')
          item.pubdate = item.pubDate = date;
        if (item.date === null || name == 'modified' || name == 'updated')
          item.date = date;
        break;
      case('link'):
        if (Array.isArray(el)) {
          el.forEach(function (link){
            if (link['@']['href']) { // Atom
              if (utils.get(link['@'], 'rel')) {
                if (link['@']['rel'] == 'canonical') item.origlink = link['@']['href'];
                if (link['@']['rel'] == 'alternate') item.link = link['@']['href'];
                if (link['@']['rel'] == 'replies') item.comments = link['@']['href'];
                if (link['@']['rel'] == 'enclosure') {
                  var enclosure = {};
                  enclosure.url = link['@']['href'];
                  enclosure.type = utils.get(link['@'], 'type');
                  enclosure.length = utils.get(link['@'], 'length');
                  item.enclosures.push(enclosure);
                }
              } else {
                item.link = link['@']['href'];
              }
            } else if (Object.keys(link['@']).length === 0) { // RSS
              if (!item.link) item.link = utils.get(link);
            }
          });
        } else {
          if (el['@']['href']) { // Atom
            if (utils.get(el['@'], 'rel')) {
              if (el['@']['rel'] == 'canonical') item.origlink = el['@']['href'];
              if (el['@']['rel'] == 'alternate') item.link = el['@']['href'];
              if (el['@']['rel'] == 'replies') item.comments = el['@']['href'];
              if (el['@']['rel'] == 'enclosure') {
                var enclosure = {};
                enclosure.url = el['@']['href'];
                enclosure.type = utils.get(el['@'], 'type');
                enclosure.length = utils.get(el['@'], 'length');
                item.enclosures.push(enclosure);
              }
            } else {
              item.link = el['@']['href'];
            }
          } else if (Object.keys(el['@']).length === 0) { // RSS
            if (!item.link) item.link = utils.get(el);
          }
        }
        if (!item.guid) item.guid = item.link;
        break;
      case('guid'):
      case('id'):
        item.guid = utils.get(el);
        break;
      case('author'):
        item.author = utils.get(el.name) || utils.get(el.email) || utils.get(el.uri);
        break;
      case('dc:creator'):
        item.author = utils.get(el);
        break;
      case('comments'):
        item.comments = utils.get(el);
        break;
      case('source'):
        if ('rss' == type) {
          item.source['title'] = utils.get(el);
          item.source['url'] = utils.get(el['@'], 'url');
        } else if ('atom' == type) {
          if (el.title && utils.get(el.title))
            item.source['title'] = utils.get(el.title);
          if (el.link && utils.get(el.link['@'], 'href'))
          item.source['url'] = utils.get(el.link['@'], 'href');
        }
        break;
      case('enclosure'):
      case('media:content'):
        var _enclosure = {};
        if (Array.isArray(el)) {
          el.forEach(function (enc){
            _enclosure.url = utils.get(enc['@'], 'url');
            _enclosure.type = utils.get(enc['@'], 'type') || utils.get(enc['@'], 'medium');
            _enclosure.length = utils.get(enc['@'], 'length') || utils.get(enc['@'], 'filesize');
            item.enclosures.push(_enclosure);
          });
        } else {
          _enclosure.url = utils.get(el['@'], 'url');
          _enclosure.type = utils.get(el['@'], 'type') || utils.get(el['@'], 'medium');
          _enclosure.length = utils.get(el['@'], 'length') || utils.get(el['@'], 'filesize');
          item.enclosures.push(_enclosure);
        }
        break;
      case('enc:enclosure'): // Can't find this in use for an example to debug. Only example found does not comply with the spec -- can't code THAT!
        break;
      case('category'):
      case('dc:subject'):
      case('itunes:category'):
      case('media:category'):
        /* We handle all the kinds of categories within the switch loop because item.categories
         * is an array, unlike the other properties, and therefore can handle multiple values
         */
        var _category = ''
          , _categories = []
          ;
        if (Array.isArray(el)) {
          el.forEach(function (category){
            if ('category' == name && 'atom' == type) {
              if (category['@'] && utils.get(category['@'], 'term')) item.categories.push(utils.get(category['@'], 'term'));
            } else if ('category' == name && utils.get(category) && 'rss' == type) {
              _categories = utils.get(category).split(',').map(function (cat){ return cat.trim(); });
              if (_categories.length) item.categories = item.categories.concat(_categories);
            } else if ('dc:subject' == name && utils.get(category)) {
              _categories = utils.get(category).split(' ').map(function (cat){ return cat.trim(); });
              if (_categories.length) item.categories = item.categories.concat(_categories);
            } else if ('itunes:category' == name) {
              if (category['@'] && utils.get(category['@'], 'text')) _category = utils.get(category['@'], 'text');
              if (category[name]) {
                if (Array.isArray(category[name])) {
                  category[name].forEach(function (subcategory){
                    if (subcategory['@'] && utils.get(subcategory['@'], 'text')) item.categories.push(_category + '/' + utils.get(subcategory['@'], 'text'));
                  });
                } else {
                  if (category[name]['@'] && utils.get(category[name]['@'], 'text'))
                    item.categories.push(_category + '/' + utils.get(category[name]['@'], 'text'));
                }
              } else {
                item.categories.push(_category);
              }
            } else if ('media:category' == name) {
              item.categories.push(utils.get(category));
            }
          });
        } else {
          if ('category' == name && 'atom' == type) {
            if (utils.get(el['@'], 'term')) item.categories.push(utils.get(el['@'], 'term'));
          } else if ('category' == name && utils.get(el) && 'rss' == type) {
            _categories = utils.get(el).split(',').map(function (cat){ return cat.trim(); });
            if (_categories.length) item.categories = item.categories.concat(_categories);
          } else if ('dc:subject' == name && utils.get(el)) {
            _categories = utils.get(el).split(' ').map(function (cat){ return cat.trim(); });
            if (_categories.length) item.categories = item.categories.concat(_categories);
          } else if ('itunes:category' == name) {
            if (el['@'] && utils.get(el['@'], 'text')) _category = utils.get(el['@'], 'text');
            if (el[name]) {
              if (Array.isArray(el[name])) {
                el[name].forEach(function (subcategory){
                  if (subcategory['@'] && utils.get(subcategory['@'], 'text')) item.categories.push(_category + '/' + utils.get(subcategory['@'], 'text'));
                });
              } else {
                if (el[name]['@'] && utils.get(el[name]['@'], 'text'))
                  item.categories.push(_category + '/' + utils.get(el[name]['@'], 'text'));
              }
            } else {
              item.categories.push(_category);
            }
          } else if ('media:category' == name) {
            item.categories.push(utils.get(el));
          }
        }
        break;
      case('feedburner:origlink'):
      case('pheedo:origlink'):
        if (!item.origlink) {
          item.origlink = utils.get(el);
        }
        break;
      } // switch end
    }
    // Fill with all native other namespaced properties
    if (name.indexOf('#') !== 0) {
      if (~name.indexOf(':')) item[name] = el;
      else item[type + ':' + name] = el;
    }
  }); // forEach end

  if (normalize) {
    if (!item.description) {
      if (node['itunes:summary']) item.description = utils.get(node['itunes:summary']);
    }
    if (!item.author) {
      if (node['itunes:author']) item.author = utils.get(node['itunes:author']);
      else if (node['itunes:owner'] && node['itunes:owner']['itunes:name']) item.author = utils.get(node['itunes:owner']['itunes:name']);
      else if (node['dc:publisher']) item.author = utils.get(node['dc:publisher']);
    }
    if (!item.image.url) {
      if (node['itunes:image']) item.image.url = utils.get(node['itunes:image']['@'], 'href');
      else if (node['media:thumbnail']) item.image.url = utils.get(node['media:thumbnail']['@'], 'url');
      else if (node['media:content'] && node['media:content']['media:thumbnail']) item.image.url = utils.get(node['media:content']['media:thumbnail']['@'], 'url');
      else if (node['media:group'] && node['media:group']['media:thumbnail']) item.image.url = utils.get(node['media:group']['media:thumbnail']['@'], 'url');
      else if (node['media:group'] && node['media:group']['media:content'] && node['media:group']['media:content']['media:thumbnail']) item.image.url = utils.get(node['media:group']['media:content']['media:thumbnail']['@'], 'url');
    }
    if (item.categories.length)
      item.categories = utils.unique(item.categories);
  }
  return item;
};

exports = module.exports = FeedParser;
