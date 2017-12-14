'use strict';

const compileRoute = require('./compile-route');

const FetchMock = {};

FetchMock.config = {
	fallThroughToNetwork: false,
	includeContentLength: true,
	sendAsJson: true,
	warnOnFallback: true,
	fallThroughToNetwork: false
}

FetchMock.createInstance = function () {
	const instance = Object.create(FetchMock);
	instance.routes = [];
	instance.config = Object.assign({}, this.config || FetchMock.config);
	instance._calls = {};
	instance._matchedCalls = [];
	instance._unmatchedCalls = [];
	instance._holdingPromises = [];
	instance.bindMethods();
	return instance;
}

FetchMock.bindMethods = function () {
	this.fetchMock = FetchMock.fetchMock.bind(this);
	this.restore = FetchMock.restore.bind(this);
	this.reset = FetchMock.reset.bind(this);
}


FetchMock.sandbox = function () {
	if (this.routes.length || this.fallbackResponse) {
		throw new Error('.sandbox() can only be called on fetch-mock instances that don\'t have routes configured already')
	}
	// this construct allows us to create a fetch-mock instance which is also
	// a callable function, while circumventing circularity when defining the
	// object that this function should be bound to
	let boundMock;
	const proxy = function () {
		return boundMock.apply(null, arguments);
	}

	const functionInstance = Object.assign(
		proxy, // Ensures that the entire returned object is a callable function
		FetchMock, // all prototype methods
		this.createInstance() // instance data
	);
	functionInstance.bindMethods();
	boundMock = functionInstance.fetchMock;
	functionInstance.isSandbox = true;
	return functionInstance;
};

FetchMock.mock = function (matcher, response, options) {

	let route;

	// Handle the variety of parameters accepted by mock (see README)
	if (matcher && response && options) {
		route = Object.assign({
			matcher,
			response
		}, options);
	} else if (matcher && response) {
		route = {
			matcher,
			response
		}
	} else if (matcher && matcher.matcher) {
		route = matcher
	} else {
		throw new Error('Invalid parameters passed to fetch-mock')
	}


	this.addRoute(route);

	return this._mock();
}

FetchMock.once = function (matcher, response, options) {
	return this.mock(matcher, response, Object.assign({}, options, {repeat: 1}));
}

FetchMock._mock = function () {
	if (!this.isSandbox) {
		// Do this here rather than in the constructor to ensure it's scoped to the test
		this.realFetch = this.realFetch || FetchMock.global.fetch;
		FetchMock.global.fetch = this.fetchMock;
	}
	return this;
}

FetchMock._unMock = function () {
	if (this.realFetch) {
		FetchMock.global.fetch = this.realFetch;
		this.realFetch = null;
	}
	this.fallbackResponse = null;
	return this;
}

FetchMock.catch = function (response) {
	if (this.fallbackResponse) {
		console.warn(`calling fetchMock.catch() twice - are you sure you want to overwrite the previous fallback response`);
	}
	this.fallbackResponse = response || 'ok';
	return this._mock();
}

FetchMock.spy = function () {
	this._mock();
	return this.catch(this.realFetch)
}

FetchMock.chill = function () {
	this._mock();
	this.config.warnOnFallback = false;
	return this.catch(this.realFetch)
}

FetchMock.fetchMock = function (url, opts) {
	const Promise = this.config.Promise;
	let resolveHoldingPromise
	const holdingPromise = new Promise(res => resolveHoldingPromise = res)
	this._holdingPromises.push(holdingPromise)
	let response = this.router(url, opts);

	if (!response) {
		console.warn(`Unmatched ${opts && opts.method || 'GET'} to ${url}`);
		this.push(null, [url, opts]);

		if (this.fallbackResponse) {
			response = this.fallbackResponse;
		} else {
			throw new Error(`No fallback response defined for ${opts && opts.method || 'GET'} to ${url}`)
		}
	}

	if (typeof response === 'function') {
		response = response(url, opts);
	}

	if (typeof response.then === 'function') {
		let responsePromise = response.then(response => this.mockResponse(url, response, opts, resolveHoldingPromise));
		return Promise.resolve(responsePromise); // Ensure Promise is always our implementation.
	} else {
		return this.mockResponse(url, response, opts, resolveHoldingPromise);
	}

}

FetchMock.router = function (url, opts) {
	let route;
	for (let i = 0, il = this.routes.length; i < il ; i++) {
		route = this.routes[i];
		if (route.matcher(url, opts)) {
			this.push(route.name, [url, opts]);
			return route.response;
		}
	}
}

FetchMock.addRoute = function (route) {

	if (!route) {
		throw new Error('.mock() must be passed configuration for a route')
	}

	// Allows selective application of some of the preregistered routes
	this.routes.push(compileRoute(route, this.config.Request, this.config.Headers));
}


FetchMock.mockResponse = function (url, responseConfig, fetchOpts, resolveHoldingPromise) {
	const Promise = this.config.Promise;

	// It seems odd to call this in here even though it's already called within fetchMock
	// It's to handle the fact that because we want to support making it very easy to add a
	// delay to any sort of response (including responses which are defined with a function)
	// while also allowing function responses to return a Promise for a response config.
	if (typeof responseConfig === 'function') {
		responseConfig = responseConfig(url, fetchOpts);
	}

	// If the response is a pre-made Response, respond with it
	if (this.config.Response.prototype.isPrototypeOf(responseConfig)) {
		return this.respond(Promise.resolve(responseConfig), resolveHoldingPromise);
	}

	// If the response says to throw an error, throw it
	if (responseConfig.throws) {
		return this.respond(Promise.reject(responseConfig.throws), resolveHoldingPromise);
	}

	// If the response config looks like a status, start to generate a simple response
	if (typeof responseConfig === 'number') {
		responseConfig = {
			status: responseConfig
		};
	// If the response config is not an object, or is an object that doesn't use
	// any reserved properties, assume it is meant to be the body of the response
	} else if (typeof responseConfig === 'string' || !(
		responseConfig.body ||
		responseConfig.headers ||
		responseConfig.throws ||
		responseConfig.status ||
		responseConfig.redirectUrl
	)) {
		responseConfig = {
			body: responseConfig
		};
	}

	// Now we are sure we're dealing with a response config object, so start to
	// construct a real response from it
	const opts = responseConfig.opts || {};

	// set the response url
	opts.url = responseConfig.redirectUrl || url;

	// Handle a reasonably common misuse of the library - returning an object
	// with the property 'status'
	if (responseConfig.status && (typeof responseConfig.status !== 'number' || parseInt(responseConfig.status, 10) !== responseConfig.status || responseConfig.status < 200 || responseConfig.status > 599)) {
		throw new TypeError(`Invalid status ${responseConfig.status} passed on response object.
To respond with a JSON object that has status as a property assign the object to body
e.g. {"body": {"status: "registered"}}`);
	}

	// set up the response status
	opts.status = responseConfig.status || 200;
	opts.statusText = FetchMock.statusTextMap['' + opts.status];

	// Set up response headers. The ternary operator is to cope with
	// new Headers(undefined) throwing in Chrome
	// https://code.google.com/p/chromium/issues/detail?id=335871
	opts.headers = responseConfig.headers ? new this.config.Headers(responseConfig.headers) : new this.config.Headers();

	// start to construct the body
	let body = responseConfig.body;

	// convert to json if we need to
	opts.sendAsJson = responseConfig.sendAsJson === undefined ? this.config.sendAsJson : responseConfig.sendAsJson;
	if (opts.sendAsJson && responseConfig.body != null && typeof body === 'object') { //eslint-disable-line
		body = JSON.stringify(body);
	}

	// add a Content-Length header if we need to
	opts.includeContentLength = responseConfig.includeContentLength === undefined ? this.config.includeContentLength : responseConfig.includeContentLength;
	if (opts.includeContentLength && typeof body === 'string' && !opts.headers.has('Content-Length')) {
		opts.headers.set('Content-Length', body.length.toString());
	}

	// On the server we need to manually construct the readable stream for the
	// Response object (on the client this is done automatically)
	if (FetchMock.stream) {
		let s = new FetchMock.stream.Readable();
		if (body != null) { //eslint-disable-line
			s.push(body, 'utf-8');
		}
		s.push(null);
		body = s;
	}
	let response = new this.config.Response(body, opts);

	// When mocking a followed redirect we must wrap the response in an object
	// which sets the redirected flag (not a writable property on the actual response)
	if (responseConfig.redirectUrl) {
		response = Object.create(response, {
			redirected: {
				value: true
			},
			url: {
				value: responseConfig.redirectUrl
			},
			// TODO extend to all other methods as requested by users
			// Such a nasty hack
			text: {
				value: response.text.bind(response)
			},
			json: {
				value: response.json.bind(response)
			}
		})
	}

	return this.respond(Promise.resolve(response), resolveHoldingPromise);
}

FetchMock.respond = function (response, resolveHoldingPromise) {
	response
		.then(resolveHoldingPromise, resolveHoldingPromise)

	return response;
}

FetchMock.flush = function () {
	return Promise.all(this._holdingPromises);
}

FetchMock.push = function (name, call) {
	if (name) {
		this._calls[name] = this._calls[name] || [];
		this._calls[name].push(call);
		this._matchedCalls.push(call);
	} else {
		this._unmatchedCalls.push(call);
	}
}

FetchMock.restore = function () {
	this._unMock();
	this.reset();
	this.routes = [];
	return this;
}

FetchMock.reset = function () {
	this._calls = {};
	this._matchedCalls = [];
	this._unmatchedCalls = [];
	this._holdingPromises = [];
	this.routes.forEach(route => route.reset && route.reset())
	return this;
}

FetchMock.calls = function (name) {
	return name ? (this._calls[name] || []) : {
		matched: this._matchedCalls,
		unmatched: this._unmatchedCalls
	};
}

FetchMock.lastCall = function (name) {
	const calls = name ? this.calls(name) : this.calls().matched;
	if (calls && calls.length) {
		return calls[calls.length - 1];
	} else {
		return undefined;
	}
}

FetchMock.lastUrl = function (name) {
	const call = this.lastCall(name);
	return call && call[0];
}

FetchMock.lastOptions = function (name) {
	const call = this.lastCall(name);
	return call && call[1];
}

FetchMock.called = function (name) {
	if (!name) {
		return !!(this._matchedCalls.length || this._unmatchedCalls.length);
	}
	return !!(this._calls[name] && this._calls[name].length);
}

FetchMock.done = function (name) {
	const names = name ? [name] : this.routes.map(r => r.name);
	// Can't use array.every because
	// a) not widely supported
	// b) would exit after first failure, which would break the logging
	return names.map(name => {
		if (!this.called(name)) {
			console.warn(`Warning: ${name} not called`);
			return false;
		}
		// would use array.find... but again not so widely supported
		const expectedTimes = (this.routes.filter(r => r.name === name) || [{}])[0].repeat;

		if (!expectedTimes) {
			return true;
		}

		const actualTimes = this.calls(name).length;
		if (expectedTimes > actualTimes) {
			console.warn(`Warning: ${name} only called ${actualTimes} times, but ${expectedTimes} expected`);
			return false;
		} else {
			return true;
		}
	})
		.filter(bool => !bool).length === 0
};

['get','post','put','delete','head', 'patch']
	.forEach(method => {
		FetchMock[method] = function (matcher, response, options) {
			return this.mock(matcher, response, Object.assign({}, options, {method: method.toUpperCase()}));
		}
		FetchMock[`${method}Once`] = function (matcher, response, options) {
			return this.once(matcher, response, Object.assign({}, options, {method: method.toUpperCase()}));
		}
	})


module.exports = FetchMock;