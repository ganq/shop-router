/**
库引入
**/
var util = require('util'),
	colors = require('colors'),
	http = require('http'),
	path = require('path'),
	fs = require('fs'),
	httpProxy = require('http-proxy'),
	urlParser = require('url'),
	mysql = require('mysql'),
	Memcached = require('memcached'),
	log4js = require('log4js'),
	PropertiesReader = require('properties-reader'),
	cluster = require('cluster');

	

var properties = PropertiesReader('conf/config.file');

if(properties.length <= 0) {
	console.log("配置文件有误,程序停止运行...");
	return;
}
/**
 系统配置。
 **/
var config = {
	dbHost : properties.get('dbHost'),
	dbUser : properties.get('dbUser'),
	dbName : properties.get('dbName'),
	dbPort : properties.get('dbPort'),
	dbPassword : properties.get('dbPassword').toString(),
	supplierWebUrl : properties.get('supplierWebUrl'),
	developerWebUrl : properties.get('developerWebUrl'),
	shopWebUrl : properties.get('shopWebUrl'),
	memcachedAddr : properties.get('memcachedAddr'),
	memcachedPoolSize : properties.get('memcachedPoolSize'),
	numCPUs : properties.get('numCPUs'),
	serverPort : properties.get('serverPort'),
	logShow : properties.get('logShow'),
	logFileName : properties.get('logFileName'),
	logLevel : properties.get('logLevel'),
	errorPage404Path : properties.get('errorPage404Path'),
	errorPage500Path : properties.get('errorPage500Path')
};

var proxy = new httpProxy.createProxyServer();	
var memcached = new Memcached(config.memcachedAddr);

Memcached.config.poolSize = config.memcachedPoolSize;

log4js.configure({
  "appenders": [
		{
			type: "console", 
			category: "serverlog"
		},
		{
			"type": "file",
			"filename": config.logFileName,
			"maxLogSize": 1024*1024*1024,
			"backups": 3,
			"category": "serverlog"
		}
	]
});

var logger = log4js.getLogger('serverlog');
logger.setLevel(config.logLevel);

var numCPUs = config.numCPUs;
if (cluster.isMaster) {
	for (var i = 0; i < numCPUs - 1; i++) {
		cluster.fork();
	}
	cluster.on('exit', function (worker, code, signal) {
		printLogInfo('worker ' + worker.process.pid + ' died');
		memcached.end();
	});
} else {
	http.createServer(function (req, res) {
		var hostPorts = req.headers.host.split(":");
		var hosts = hostPorts[0];
		var host = hosts.split(".");
		var hostPrefix = host[0].toLowerCase();
		var currentPath = urlParser.parse(req.url).path;
		
		printLogInfo('-------------------------------------我是分割线-------------------------------------');
		printLogInfo("开始接收请求.");
		
		var currentUrl = "http://" + req.headers.host + currentPath;
		
		printLogInfo("当前请求路径 :" + currentUrl);
		
		var isSupplier = (hostPrefix === "g");
		var isDeveloper = hostPrefix.match(/^k\d{6,}$/);
		var isShop = (hostPrefix === "s");						//个人店铺
		var currentCompanyType = isDeveloper?"1":(isSupplier?"2":"3");
		
		if(isSupplier || isDeveloper || isShop){
			currentPath = currentPath.substr(1).toLowerCase();
			var domainId = hostPrefix;
			if(isSupplier){
				domainId = currentPath;
			}
			if(isShop){
				if(currentPath.indexOf("preview") >= 0){
					domainId = currentPath.replace("-preview","");
				}else{
					domainId = currentPath;
				}
			}
			printLogInfo("当前为id模式进入..得到的id为：" + domainId);
			setTimeout(function () {
				memcached.get("DOMAIN_ID_" + domainId, function (err, data) {
					if (err) {
					
						printLogInfo('Memcache连接失败！！错误: ' + err.message,"error");
						
						handle500Error(req,res);
						return;
					}
					
					if (data) {
					
						printLogInfo("当前Id在缓存中查询有数据.");
						
						var arr = data.split("|");
						if (arr.length == 2) {
							var companyAlias = arr[0];
							var companyType = parseInt(arr[1]);
							
							printLogInfo("缓存数据正确,查到公司别名为:" + companyAlias + ", 公司类型为:" + companyType);
							var jumpUrl;
							if(isSupplier){							
								jumpUrl = currentUrl.replace(domainId,"").replace("http://g","http://" + companyAlias);
							}else{
								jumpUrl = currentUrl.replace(domainId,companyAlias);							
							}
							printLogInfo("马上跳转到：" + jumpUrl);
							if (companyAlias != null && companyType != null) {
								res.writeHead(301, {
									Location: jumpUrl
								});
								res.end();
								return;
							}
						} else if (arr.length == 1 && arr[0] == "invalid") {
							
							var url = null;
							if (currentCompanyType == 1) {
								url = config.developerWebUrl;
							} else if(currentCompanyType == 2) {
								url = config.supplierWebUrl;
							} else if(currentCompanyType == 3) {
								url = config.shopWebUrl;
							} else {
								handle500Error(req,res);
								return;
							}

							printLogInfo("缓存中数据异常,数据为invalid,将直接跳转到：" + currentUrl);
							
							proxy.web(req, res, {
								target: url
							});
							return;
						}else{
							printLogInfo("缓存数据异常,数据为:" + arr + ",将直接展示500页面");
							handle500Error(req,res);
							return;
						}
						return;
						
					} else {
						
						printLogInfo("缓存中没有相应数据,将检查DB.");
						
						var connection = mysql.createConnection({host: config.dbHost, port: config.dbPort, user: config.dbUser, password: config.dbPassword});
						connection.connect(function (err) {
							if (err) {
								printLogInfo('Mysql 连接异常！！ 错误: ' + err.message,"error");
								handle500Error(req,res);
								return;
							}
							
							printLogInfo('MySQL连接成功');
							
							ClientConnectionReady(connection, domainId,currentCompanyType,currentUrl, req, res);
						});
						return;
					}
				});
			}, 10);
		} else{
		
			printLogInfo("当前为别名模式进入..");
			
			setTimeout(function () {
				memcached.get("DOMAIN_ALIAS_" + hostPrefix, function (err, data) {
					if (err) {
						
						printLogInfo('Memcache 连接异常 错误: ' + err.message,"error");
						
						handle500Error(req,res);
						return;
					}

					if (data) {
					
						printLogInfo("当前别名在缓存中查询有数据.");
						
						var arr = data.split("|");
						if (arr.length == 2) {
							var companyAlias = arr[0];
							var companyType = parseInt(arr[1]);
							if (companyAlias != null && companyType != null) {
								
								printLogInfo("缓存数据正确,查询到公司别名为:" + companyAlias + ", 公司类型为:" + companyType);
								
								var url = null;
								if (companyType == 1) {
									url = config.developerWebUrl;
								} else if(companyType == 2) {
									url = config.supplierWebUrl;
								} else if(companyType == 3) {
									url = config.shopWebUrl;
								} else {
									handle500Error(req,res);
									return;
								}

								printLogInfo('马上跳转到：' + currentUrl);
								
								proxy.web(req, res, {
									target: url
								});
								return;
							}

						} else {
							printLogInfo("缓存数据异常,data:" + arr + ",将直接展示404页面");
							handle404Error(req,res);
							return;
						}
						return;						
					} else {
					
						printLogInfo("缓存中没有相应数据,将检查DB.");
						
						var connection = mysql.createConnection({host:config.dbHost,port:config.dbPort,user:config.dbUser,password:config.dbPassword});
						connection.connect(function (err) {
							if (err) {
								printLogInfo('Mysql Connection Error: ' + err.message,"error");
								handle500Error(req,res);
								return;
							}
							
							printLogInfo('MySQL连接成功');
							
							ClientConnectionReadyByAlias(connection, hostPrefix,currentUrl, req, res);
						});
						return;
					}
				});
			}, 10);
		}		
	}).listen(config.serverPort);
}

var ClientConnectionReady = function (connection, hostPrefix,companyType, currentUrl,req, res) {
	connection.query('use ' + config.dbName, function (error, results) {
		if (error) {
		
			printLogInfo('数据库引用表连接失败！！ 错误: ' + error,"error");
			
			connection.end();
			handle500Error(req,res);
			return;
		}
		GetData(connection, hostPrefix,companyType,currentUrl, req, res);
	});
};
	
var ClientConnectionReadyByAlias = function (connection, hostPrefix,currentUrl, req, res) {
	connection.query('use ' + config.dbName, function (error, results) {
		if (error) {
			
			printLogInfo('数据库引用表连接失败！！ 错误: ' + error,"error");
			
			connection.end();
			handle500Error(req,res);
			return;
		}
		GetDataByAlias(connection, hostPrefix,currentUrl, req, res);
	});
};

var GetData = function (connection, hostPrefix, companyType,currentUrl,req, res) {
	connection.query('SELECT prefix,type FROM bsp_domain where company_id=?', [hostPrefix],function selectCb(error, results, fields) {
		if (error) {
		
			printLogInfo("执行sql查询失败！！错误: " + error.message,"error");
			
			connection.end();
			handle500Error(req,res);
			return;
		}

		if (results.length > 0) {
			
			printLogInfo('根据公司Id查询公司信息成功');
			
			var firstResult = results[0];
			var companyAlias = firstResult['prefix'];
			var type = firstResult['type'];
			
			connection.end();
			printLogInfo("数据库连接关闭");
			
			if (companyAlias != null && type != null) {
			
				printLogInfo("根据公司ID :" + hostPrefix + "得到的公司别名为：" + companyAlias + ",公司类型为:" + type);				
				
				var memKey = "DOMAIN_ID_" + hostPrefix;
				var memValue = companyAlias + "|" + type;
				//10分钟失效
				memcached.add(memKey, memValue, 600, function (err) {
					if(err) {
						
						printLogInfo("Memcache增加键值错误!!键：" + memKey + " 值：" + memValue + " 错误" + err ,"error");
						
						return;
					}
					
					printLogInfo("Memcache增加键值成功！键：" + memKey + " 值：" + memValue);
				});
				var jumpUrl;
				if(companyType == 2){							
					jumpUrl = currentUrl.replace(hostPrefix,"").replace("http://g","http://" + companyAlias);
				}else{
					jumpUrl = currentUrl.replace(hostPrefix,companyAlias);							
				}
				printLogInfo("马上跳转到：" + jumpUrl);
				res.writeHead(301, {
					Location: jumpUrl
				});
				res.end();
				
				return;
			} else {
			
				printLogInfo("根据公司ID :" + companyAlias + "查询的数据异常.");	
				
				var memKey = "DOMAIN_ID_" + hostPrefix;
				var memValue = "invalid";				
				
				memcached.add("DOMAIN_ID_" + hostPrefix, "invalid", 600, function (err) {
					if(err) {
						printLogInfo("Memcache增加键值错误!!键：" + memKey + " 值：" + memValue + " 错误" + err ,"error");
						return;
					}
					
					printLogInfo("Memcache增加键值成功！键：" + memKey + " 值：" + memValue);
				});
			
				var url = null;
				if (companyType == 1) {
					url = config.developerWebUrl;
				} else if(companyType == 2) {
					url = config.supplierWebUrl;
				} else if(companyType == 3) {
					url = config.shopWebUrl;
				} else {
					handle500Error(req,res);
					return;
				}
				printLogInfo("将直接跳转到：" + currentUrl);
				proxy.web(req, res, {
					target: url
				});
				
				return;
			}
		} else {
		
			printLogInfo("通过公司id查询不到数据库中数据,直接跳转..");
			
			connection.end();
			printLogInfo("数据库连接关闭");
			
			var memKey = "DOMAIN_ID_" + hostPrefix;
			var memValue = "invalid";
			memcached.add(memKey, memValue, 600, function (err) {
				if(err) {
					printLogInfo("Memcache增加键值错误!!键：" + memKey + " 值：" + memValue + " 错误" + err ,"error");												
				}
				
				printLogInfo("Memcache增加键值成功！键：" + memKey + " 值：" + memValue);
			});
			
			var url = null;
			if (companyType == 1) {
				url = config.developerWebUrl;
			} else if(companyType == 2) {
				url = config.supplierWebUrl;
			} else if(companyType == 3) {
				url = config.shopWebUrl;
			} else {
				handle500Error(req,res);
				return;
			}
		
			printLogInfo("将直接跳转到：" + currentUrl);
			proxy.web(req, res, {
				target: url
			});
			return;
		}

	});
};

var GetDataByAlias = function (connection, hostPrefix,currentUrl, req, res) {
	connection.query('SELECT prefix,type FROM bsp_domain where prefix=?', [hostPrefix],function selectCb(error, results, fields) {
		if (error) {
		
			printLogInfo("执行sql查询失败！！错误: " + error.message,"error");
			
			connection.end();
			return;
		}

		if (results.length > 0) {
		
			printLogInfo("别名" + hostPrefix + "检查成功！");
			
			var firstResult = results[0];
			var companyAlias = firstResult['prefix'];
			var companyType = firstResult['type'];			
			
			connection.end();
			printLogInfo("数据库连接关闭");
			
			if (companyAlias != null && companyType != null) {	
			
				printLogInfo("根据公司别名 :" + companyAlias + "得到的公司类型为:" + companyType);			
				
				var memKey = "DOMAIN_ALIAS_" + hostPrefix;
				var memValue = companyAlias + "|" + companyType;
				//10分钟失效
				memcached.add(memKey, memValue, 600, function (err) {
					if(err) {
						printLogInfo("Memcache增加键值错误!!键：" + memKey + " 值：" + memValue + " 错误" + err ,"error");	
						return;
					}
					printLogInfo("Memcache增加键值成功！键：" + memKey + " 值：" + memValue);
				});		
				
				if (companyType == 1) {
					url = config.developerWebUrl;
				} else if(companyType == 2) {
					url = config.supplierWebUrl;
				} else if(companyType == 3) {
					url = config.shopWebUrl;
				} else {
					handle404Error(req,res);
					return;
				}
				
				printLogInfo("将直接跳转到：" + currentUrl);
				proxy.web(req, res, {
					target: url
				});				
				return;

			} else {
				printLogInfo("别名" + hostPrefix + "检查异常！");
				var memKey = "DOMAIN_ALIAS_" + hostPrefix;
				var memValue = "invalid";	
				memcached.add(memKey, memValue, 600, function (err) {
					if(err) {
						printLogInfo("Memcache增加键值错误!!键：" + memKey + " 值：" + memValue + " 错误" + err ,"error");	
						return;
					}
					
					printLogInfo("Memcache增加键值成功！键：" + memKey + " 值：" + memValue);

				});				
				printLogInfo("将跳转404页面.");
				handle404Error(req,res);						
				return;
			}
		} else {
			connection.end();
			printLogInfo("数据库连接关闭");
			var memKey = "DOMAIN_ALIAS_" + hostPrefix;
			var memValue = "invalid";	
			memcached.add(memKey, memValue, 600, function (err) {
				if(err) {
					printLogInfo("Memcache增加键值错误!!键：" + memKey + " 值：" + memValue + " 错误" + err ,"error");	
					return;
				}
				
				printLogInfo("Memcache增加键值成功！键：" + memKey + " 值：" + memValue);

			});		
			
			printLogInfo("别名检查数据库中不存在..将跳转404页面");
			handle404Error(req,res);
			return;
		}
	});
};

var handle404Error = function (req, response) {
	// 读取404页面
	fs.exists(config.errorPage404Path, function (exists) {
		if (!exists) {
			response.writeHead(404, {'Content-Type': 'text/plain'});
			response.write("404 页面文件不存在.");
			response.end();
		} else {
			fs.readFile(config.errorPage404Path, "binary", function(err, file) {
				if (err) {
					response.writeHead(500, {'Content-Type': 'text/plain'});
					response.end(err);
				} else {
					response.writeHead(404, {'Content-Type': 'text/html'});
					response.write(file, "binary");
					response.end();
				}
			});
		}
	});	
};

var handle500Error = function (req, response) {
	// 读取500页面
	fs.exists(config.errorPage500Path, function (exists) {
		if (!exists) {
			response.writeHead(404, {'Content-Type': 'text/plain'});
			response.write("500 页面文件不存在.");
			response.end();
		} else {
			fs.readFile(config.errorPage500Path, "binary", function(err, file) {
				if (err) {
					response.writeHead(500, {'Content-Type': 'text/plain'});
					response.end(err);
				} else {
					response.writeHead(500, {'Content-Type': 'text/html'});
					response.write(file, "binary");
					response.end();
				}
			});
		}
	});	
};

var printLogInfo = function (logInfo,logLevel) {
	if(config.logShow && config.logShow === "on"){
		if(logLevel && logLevel === "error"){
			logger.error(logInfo);
		}else{
			logger.info(logInfo);
		}
	}	
}

proxy.on('error', function (err, req, res) {
	handle404Error(req,res);
	printLogInfo('httpProxy异常,错误：' + err.message);
});