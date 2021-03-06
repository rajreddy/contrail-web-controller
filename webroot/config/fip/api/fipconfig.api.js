/*
 * Copyright (c) 2014 Juniper Networks, Inc. All rights reserved.
 */

/**
 * @fipconfig.api.js
 *     - Handlers for Floating IP Configuration
 *     - Interfaces with config api server
 */

var rest         = require(process.mainModule.exports["corePath"] +
                           '/src/serverroot/common/rest.api');
var async        = require('async');
var fipconfigapi = module.exports;
var logutils     = require(process.mainModule.exports["corePath"] +
                           '/src/serverroot/utils/log.utils');
var commonUtils  = require(process.mainModule.exports["corePath"] +
                           '/src/serverroot/utils/common.utils');
var config       = process.mainModule.exports["config"];
var messages     = require(process.mainModule.exports["corePath"] +
                           '/src/serverroot/common/messages');
var global       = require(process.mainModule.exports["corePath"] +
                           '/src/serverroot/common/global');
var appErrors    = require(process.mainModule.exports["corePath"] +
                           '/src/serverroot/errors/app.errors');
var util         = require('util');
var url          = require('url');
var UUID         = require('uuid-js');
var configApiServer = require(process.mainModule.exports["corePath"] +
                              '/src/serverroot/common/configServer.api');

/**
 * Bail out if called directly as "nodejs fipconfig.api.js"
 */
if (!module.parent) {
    logutils.logger.warn(util.format(messages.warn.invalid_mod_call,
                                     module.filename));
    process.exit(1);
}

/**
 * @listFloatingIpsCb
 * private function
 * 1. Callback for listFloatingIps
 * 2. Reads the response of per project floating ips from config api server
 *    and sends it back to the client.
 */
function listFloatingIpsCb (error, fipListData, response) 
{
    if (error) {
       commonUtils.handleJSONResponse(error, response, null);
       return;
    }
    commonUtils.handleJSONResponse(error, response, fipListData);
}

/**
 * @fipListAggCb
 * private function
 * 1. Callback for the fip gets, sends all fips to client.
 */
function fipListAggCb (error, results, callback) 
{
    var fipConfigBackRefs = {};

    if (error) {
        callback(error, null);
        return;
    }

    fipConfigBackRefs['floating_ip_back_refs'] = [];
    fipConfigBackRefs['floating_ip_back_refs'] = results;
    callback(error, fipConfigBackRefs);
}

/**
 * @getFipsForProjectCb
 * private function
 * 1. Callback for listFloatingIps
 * 2. Gets the list of Fip backrefs and does an individual
 *    get for each one of them.
 */
function getFipsForProjectCb (error, fipListData, response, appData)
{
    var reqUrl            = null;
    var dataObjArr        = [];
    var i = 0, fipLength  = 0;
    var fipConfigBackRefs = {};
    var fipObjArr = [];

    if (error) {
       commonUtils.handleJSONResponse(error, response, null);
       return;
    }

    fipConfigBackRefs['floating_ip_back_refs'] = [];

    if ('floating_ip_back_refs' in fipListData['project']) {
        fipConfigBackRefs['floating_ip_back_refs'] =
              fipListData['project']['floating_ip_back_refs'];
    }

    fipLength = fipConfigBackRefs['floating_ip_back_refs'].length;

    if (!fipLength) {
        commonUtils.handleJSONResponse(error, response, fipConfigBackRefs);
        return;
    }

    for (i = 0; i < fipLength; i++) {
       fipRef = fipConfigBackRefs['floating_ip_back_refs'][i];
       reqUrl = '/floating-ip/' + fipRef['uuid'];
       commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET,
                                null, null, null, appData);
    }

    async.map(dataObjArr,
        commonUtils.getAPIServerResponse(configApiServer.apiGet, false),
        function(error, results) {
        fipListAggCb(error, results, function (err, fipAggList) {
            if (err) {
               commonUtils.handleJSONResponse(err, response, null);
               return;
            }
            if(fipAggList && fipAggList['floating_ip_back_refs'] && fipAggList['floating_ip_back_refs'].length > 0) {
                for(var i=0; i<fipAggList['floating_ip_back_refs'].length; i++) {
                    var fipBackRef = fipAggList['floating_ip_back_refs'][i];
                    if('floating-ip' in fipBackRef && 
                        'virtual_machine_interface_refs' in fipBackRef['floating-ip'] &&
                        fipBackRef['floating-ip']['virtual_machine_interface_refs'].length > 0) {
                        for(var j=0; j<fipBackRef['floating-ip']['virtual_machine_interface_refs'].length; j++) {
                            var vmiRef = fipBackRef['floating-ip']['virtual_machine_interface_refs'][j];
                            fipObjArr.push({'appData' : appData, 'vmiRef' : vmiRef, 'fip' : fipBackRef, 'fip_uuid' : fipBackRef['floating-ip']['uuid']});
                        }
                    }
                }
                if(fipAggList['floating_ip_back_refs'].length > 0) {
                    async.mapSeries(fipObjArr, getInstanceIPForVirtualMachineInterface, function(err, fipDetailData) {
                        if(err) {
                            commonUtils.handleJSONResponse(error, response, fipAggList);
                        }
                        else {
                            updateFipAggrList(err, response, fipAggList, fipDetailData);
                        }
                    });
                } else {
                    commonUtils.handleJSONResponse(error, response, fipAggList);
                }
          }
        });
    });
}

/**
 * @updateFipAggrList
 * private function
 * 1. Callback from getFipsForProjectCb
 * 2. Updates the original list of floating ip backrefs with  
 *    floating ip list with instance_ip_refs details, if any, of individual 
 *    virtual machine interface got from getInstanceIPForVirtualMachineInterface. 
 */
function updateFipAggrList(err, response, fipAggList, fipDetailData) {
    for(var i=0; i<fipAggList['floating_ip_back_refs'].length; i++) {
        for(var j=0; j<fipDetailData.length; j++) {
            if(fipAggList['floating_ip_back_refs'][i]['floating-ip']['uuid'] ==
              fipDetailData[j]['floating-ip']['uuid']) {
                fipAggList['floating_ip_back_refs'][i] = fipDetailData[j];
            }
        }
    }
    commonUtils.handleJSONResponse(err, response, fipAggList);
}

/**
 * @getInstanceIPForVirtualMachineInterface
 * private function
 * 1. Gets instance_ip_refs for each VMI of a Floating IP.
 * 2. Updates the list of floating ip backrefs with virtual_machine_refs 
 *    of individual virtual machine interface of the floating ip. 
 */
function getInstanceIPForVirtualMachineInterface(fipObj, callback) {
    var appData = fipObj['appData'];    
    var reqUrl = '/virtual-machine-interface/' + fipObj['vmiRef']['uuid'];
    var fip = fipObj["fip"];
    configApiServer.apiGet(reqUrl, appData, function(err, vmiData) {
        if (err) {
            callback(err, null);
            return;
        } else {
            for(var i=0; i<fip['floating-ip']['virtual_machine_interface_refs'].length; i++) {
                var vmiRef = fip['floating-ip']['virtual_machine_interface_refs'][i];
                if(vmiRef["uuid"] === vmiData['virtual-machine-interface']["uuid"]) {
                    fip['floating-ip']['virtual_machine_interface_refs'][i]["virtual_machine_refs"] = [];
                    fip['floating-ip']['virtual_machine_interface_refs'][i]["virtual_machine_refs"] = 
                        vmiData['virtual-machine-interface']['virtual_machine_refs']
                    callback(err, fip);
                }
            }
        }
    });
}

function listFloatingIpsAsync (fipObj, callback)
{
    var fipObjArr = [];
    var dataObjArr = fipObj['reqDataArr'];
    var reqLen = dataObjArr.length;

    for (var i = 0; i < reqLen; i++) {
        reqUrl = '/floating-ip/' + dataObjArr[i]['uuid'];
        commonUtils.createReqObj(fipObjArr, reqUrl, null, null, null, null,
                                 dataObjArr[i]['appData']);
    }
    if (!reqLen) {
        callback(null, null);
        return;
    }
    async.map(fipObjArr,
              commonUtils.getAPIServerResponse(configApiServer.apiGet, false),
              function(err, results) {
        fipListAggCb(err, results, function (err, data) {
            callback(err, data);
        });
    });
}

/**
 * @listFloatingIps
 * public function
 * 1. URL /api/tenants/config/floating-ips/:id
 * 2. Gets list of floating ips from  project's fip backrefs
 * 3. Needs tenant / project  id as the id
 * 4. Calls listFloatingIpsCb that process data from config
 *    api server and sends back the http response.
 */
function listFloatingIps (request, response, appData) 
{
    var tenantId      = null;
    var requestParams = url.parse(request.url,true);
    var projectURL   = '/project';

    if ((tenantId = request.param('id'))) {
        projectURL += '/' + tenantId.toString();
    } else {
        /**
         * TODO - Add Language independent error code and return
         */
    }
    configApiServer.apiGet(projectURL, appData,
                         function(error, data) {
                         getFipsForProjectCb(error, data, response, appData);
                         });
}

/**
 * @getFipPoolsForProjectCb
 * private function
 * 1. Callback for getFipPoolsForProject
 */
function getFipPoolsForProjectCb (error, projectData, appData, callback) 
{
    var fipPool = {};
    var fipPoolReqArry = [];
    if (error) {
       callback(error, fipPool);
       return;
    }
    fipPool['floating_ip_pool_refs'] = [];
    if ('floating_ip_pool_refs' in projectData['project']) {
        fipPool['floating_ip_pool_refs'] =
               projectData['project']['floating_ip_pool_refs'];
        var poolLength = fipPool['floating_ip_pool_refs'].length;   
        for(var poolCnt = 0; poolCnt <  poolLength; poolCnt++) {
            var fipPoolReqUrl = '/floating-ip-pool/' + fipPool['floating_ip_pool_refs'][poolCnt].uuid;
            commonUtils.createReqObj(fipPoolReqArry, fipPoolReqUrl, global.HTTP_REQUEST_GET,
                null, null, null, appData);            
        }
        if(fipPoolReqArry.length > 0) {
            async.map(fipPoolReqArry, commonUtils.getAPIServerResponse(configApiServer.apiGet, true)
                , function(err, data){
                var nwReqArry = [];
                if (error) {
                     commonUtils.handleJSONResponse(error, response, null);
                     return;
                }
                if(data && data.length > 0) {
                    for(var poolCnt = 0; poolCnt <  data.length; poolCnt++) {
                        try {
                            var nwReqUrl =  '/' + data[poolCnt]['floating-ip-pool']['parent_type'] 
                                + '/' + data[poolCnt]['floating-ip-pool']['parent_uuid'];    
                            commonUtils.createReqObj(nwReqArry, nwReqUrl, global.HTTP_REQUEST_GET,
                                null, null, null, appData);            
                              
                        } catch (e) {
                            logUtils.logger.error('getFipPoolsForProjectCb: JSON parse error :' + e);
                        }
                    }
                    if(nwReqArry.length > 0) { 
                        getFIPPoolSubnets(nwReqArry, appData, fipPool, function(subnetErr, finalFipPool) {
                            if(subnetErr) {
                                callback(subnetErr, finalFipPool);
                                return;
                            }
                            callback(null, finalFipPool);
                        });
                    } else {
                        callback(null, fipPool);
                    }    
                }                
            });        
        } else {
            callback(null, fipPool);
        }    
    } else {
        callback(null, fipPool);
    }
}

/**
 * @getFloatingIpPoolsByProject
 * private function
 * 1. Gets list of floating ip pools  from  Project's fip
 *    pool  refs
 */
function getFloatingIpPoolsByProject (request, appData, callback)
{
    var tenantId      = null;
    var requestParams = url.parse(request.url,true);
    var projectURL    = '/project';

    if ((tenantId = request.param('id'))) {
        projectURL += '/' + tenantId.toString();
    } else {
        /**
         * TODO - Add Language independent error code and return
         */
    }
    configApiServer.apiGet(projectURL, appData,
                         function(error, data) {
                         getFipPoolsForProjectCb(error, data, appData, callback);
    });
}
    
/**
 * @getFloatingIpPoolsByVNLists
 * private function
 * 1. Gets list of floating ip pools  from  All VNs' fip
 *    pool  refs
 */
function getFloatingIpPoolsByVNLists (request, appData, callback)
{
    var vnListURL = '/virtual-networks';
    var fipPool = {};
    var dataObjArr = [];
    fipPool['floating_ip_pool_refs'] = [];
    configApiServer.apiGet(vnListURL, appData, function(err, vnList) {
        if ((null != err) || (null == vnList) || 
            (null == vnList['virtual-networks'])) {
            callback(err, fipPool);
            return;
        }
        var vns = vnList['virtual-networks'];
        var vnCnt = vns.length;
        for (var i = 0; i < vnCnt; i++) {
            var vnURL = '/virtual-network/' + vns[i]['uuid'] +
            '?exclude_back_refs=true';
            commonUtils.createReqObj(dataObjArr, vnURL, global.HTTP_REQUEST_GET,
                                     null, null, null, appData);
        }
        if (!dataObjArr.length) {
            callback(null, fipPool);
            return;
        }
        async.map(dataObjArr, 
                  commonUtils.getAPIServerResponse(configApiServer.apiGet,
                                                   true),
                  function(error, results) {
            if ((null != error) || (null == results)) {
                callback(error, fipPool);
                return;
            }
            var resCnt = results.length;
            for (i = 0; i < resCnt; i++) {
                try {
                    var vn = results[i]['virtual-network'];
                    if ((true == vn['router_external']) &&
                        (null != vn['floating_ip_pools'])) {
                        var subnets = parseVNSubnets(results[i]);
                        var fipCnt = vn['floating_ip_pools'].length;
                        for(var j = 0; j < fipCnt ; j++) {  
                            vn['floating_ip_pools'][j]['subnets'] =  subnets;                       
                            fipPool['floating_ip_pool_refs'].push(vn['floating_ip_pools'][j]);                                
                        }    
                    }
                } catch(e) {
                    continue;
                }
            }
            callback(null, fipPool);
        });
    });
}

/**
 * @listFloatingIpPools
 * public function
 * 1. URL /api/tenants/config/floating-ip-pools/:id
 * 2. Gets list of floating ip pools  from  project's and all VNs' fip
 *    pool refs.
 *
 */
function listFloatingIpPools (request, response, appData) 
{
    var resFipPools = {'floating_ip_pool_refs': []};
    async.parallel([
        function(callback) {
            getFloatingIpPoolsByProject(request, appData, 
                                        function(error, data) {
                callback(null, data);
            });
        },
        function(callback) {
            getFloatingIpPoolsByVNLists(request, appData,
                                        function(error, data) {
                callback(null, data);
            });
        }
    ],
    function(err, results) {
        var tempFipPoolObjs = {};
        if (null == results) {
            commonUtils.handleJSONResponse(null, response, resFipPools);
            return;
        }
        var fipPoolsByProjCnt = 0;
        var fipPoolsByVNsCnt = 0;
        try {
            var fipPoolsByProj = results[0]['floating_ip_pool_refs'];
            fipPoolsByProjCnt = fipPoolsByProj.length;
        } catch(e) {
            fipPoolsByProjCnt = 0;
        }
        try {
            var fipPoolsByVNs = results[1]['floating_ip_pool_refs'];
            fipPoolsByVNsCnt = fipPoolsByVNs.length;
        } catch(e) {
            fipPoolsByVNsCnt = 0;
        }
        var fipFqn = null;
        for (var i = 0; i < fipPoolsByProjCnt; i++) {
            fipFqn = fipPoolsByProj[i]['to'].join(':');
            if (null == tempFipPoolObjs[fipFqn]) {
                resFipPools['floating_ip_pool_refs'].push(fipPoolsByProj[i]);
                tempFipPoolObjs[fipFqn] = fipFqn;
            }
        }
        for (i = 0; i < fipPoolsByVNsCnt; i++) {
            fipFqn = fipPoolsByVNs[i]['to'].join(':');
            if (null == tempFipPoolObjs[fipFqn]) {
                resFipPools['floating_ip_pool_refs'].push(fipPoolsByVNs[i]);
                tempFipPoolObjs[fipFqn] = fipFqn;
            }
        }
        commonUtils.handleJSONResponse(err, response, resFipPools);
    });
}

/**
 * @fipSendResponse
 * private function
 * 1. Sends back the response of fip read to clients after set operations.
 */
function fipSendResponse(error, fipConfig, response) 
{
    if (error) {
       commonUtils.handleJSONResponse(error, response, null);
    } else {
       commonUtils.handleJSONResponse(error, response, fipConfig);
    }
    return;
}

/**
 * @setFipRead
 * private function
 * 1. Callback for Fip create / update operations
 * 2. Reads the response of Fip get from config api server
 *    and sends it back to the client.
 */
function setFipRead(error, fipConfig, response, appData) 
{
    var fipGetURL = '/floating-ip/';

    if (error) {
       commonUtils.handleJSONResponse(error, response, null);
       return;
    }

    fipGetURL += fipConfig['floating-ip']['uuid'];
    configApiServer.apiGet(fipGetURL, appData,
                         function(error, data) {
                         fipSendResponse(error, data, response)
                         });
}

/**
 * @createFloatingpIp
 * public function
 * 1. URL /api/tenants/config/floating-ips - Post
 * 2. Sets Post Data and sends back the floating-ip config to client
 */
function createFloatingIp (request, response, appData) 
{
    var fipCreateURL = '/floating-ips';
    var fipPostData  = request.body;

    if (typeof(fipPostData) != 'object') {
        error = new appErrors.RESTServerError('Invalid Post Data');
        commonUtils.handleJSONResponse(error, response, null);
        return;
    }

    if ((!('floating-ip' in fipPostData)) ||
        (!('fq_name' in fipPostData['floating-ip'])) ||
        (!(fipPostData['floating-ip']['fq_name'][3].length))) {
        error = new appErrors.RESTServerError('Invalid Floating IP Pool');
        commonUtils.handleJSONResponse(error, response, null);
        return;
    }

    if (!(['name'] in fipPostData['floating-ip']) ||
        !(fipPostData['floating-ip']['name'].length)) {
        uuid = UUID.create();
        fipPostData['floating-ip']['name'] = uuid['hex'];
        fipPostData['floating-ip']['uuid'] = uuid['hex'];
        fipPostData['floating-ip']['fq_name'][4] =
                                  fipPostData['floating-ip']['name'];
    }

    configApiServer.apiPost(fipCreateURL, fipPostData, appData,
                         function(error, data) {
                         setFipRead(error, data, response, appData);
                         });

}

/**
 * @deleteFloatingIpCb
 * private function
 * 1. Return back the response of fip delete.
 */
function deleteFloatingIpCb (error, fipDelResp, response) 
{

    if (error) {
        commonUtils.handleJSONResponse(error, response, null);
        return;
    }

    commonUtils.handleJSONResponse(error, response, fipDelResp);
}

/**
 * @deleteFloatingIp
 * public function
 * 1. URL /api/tenants/config/floating-ip/:id
 * 2. Deletes the floating-ip from config api server
 */
function deleteFloatingIp (request, response, appData) 
{
    var fipDelURL     = '/floating-ip/';
    var fipId         = null;
    var requestParams = url.parse(request.url, true);

    if (fipId = request.param('id').toString()) {
        fipDelURL += fipId;
    } else {
        error = new appErrors.RESTServerError('Provide Floating IP Id');
        commonUtils.handleJSONResponse(error, response, null);
        return;
    }
    configApiServer.apiDelete(fipDelURL, appData,
                            function(error, data) {
                            deleteFloatingIpCb(error, data, response)
                            });
}

/**
 * @setFipVMInterface
 * private function
 * 1. Callback for updateFloatingIp
 * 2. Updates the vm interface backrefs
 */
function setFipVMInterface(error, fipConfig, fipPostData, fipId, response,
                           appData) 
{
    var fipPostURL = '/floating-ip/' + fipId;

    if (error) {
       commonUtils.handleJSONResponse(error, response, null);
       return;
    }

    if (!('virtual_machine_interface_refs' in fipPostData['floating-ip'])) {
        fipPostData['floating-ip']['virtual_machine_interface_refs'] = [];
    }

    fipConfig['floating-ip']['virtual_machine_interface_refs'] = [];
    fipConfig['floating-ip']['virtual_machine_interface_refs'] =
           fipPostData['floating-ip']['virtual_machine_interface_refs'];

    configApiServer.apiPut(fipPostURL, fipConfig, appData,
                         function(error, data) {
                         setFipRead(error, data, response, appData)
                         });
}

/**
 * @updateFloatingIp
 * public function
 * 1. URL /api/tenants/config/floating-ip/:id - Put
 * 2. Sets Post Data and sends back the policy to client
 */
function updateFloatingIp (request, response, appData) 
{
    var fipId       = null;
    var vmRef       = {};
    var fipGetURL   = '/floating-ip/';
    var fipPostData = request.body;

    if (typeof(fipPostData) != 'object') {
        error = new appErrors.RESTServerError('Invalid Post Data');
        commonUtils.handleJSONResponse(error, response, null);
        return;
    }

    if (fipId = request.param('id').toString()) {
        fipGetURL += fipId;
    } else {
        error = new appErrors.RESTServerError('Add Floating Ip ID');
        commonUtils.handleJSONResponse(error, response, null);
        return;
    }

    if ('floating-ip' in fipPostData &&
        'virtual_machine_interface_refs' in fipPostData['floating-ip'] &&
        fipPostData['floating-ip']['virtual_machine_interface_refs'] &&
        fipPostData['floating-ip']
                   ['virtual_machine_interface_refs'].length) {

        vmRef = fipPostData['floating-ip']
                           ['virtual_machine_interface_refs'][0];
        if ((!('to' in vmRef)) || (vmRef['to'].length != 3)) {
            error = new appErrors.RESTServerError('Add valid Instance \n' +
                                                  JSON.stringify(vmRef));
            commonUtils.handleJSONResponse(error, response, null);
            return;
        }
    }

    configApiServer.apiGet(fipGetURL, appData,
                        function(error, data) {
                        setFipVMInterface(error, data, fipPostData,
                                          fipId, response, appData);
                        });
}

/**
 * @getFIPPoolSubnets
 * private function
 * 1. gets subnets for the floating ip pools
 */
function getFIPPoolSubnets (nwReqArry, appData, fipData, callback) 
{
    async.map(nwReqArry, commonUtils.getAPIServerResponse(configApiServer.apiGet, true)
        , function(error, data) {
        var subnetMap = [];
        if(error) {
            callback(error, fipData);
            return;            
        }
        for(var nwCnt = 0; nwCnt < data.length; nwCnt++) {
            var subNetStr = parseVNSubnets(data[nwCnt]);   
            var fipPoolList = data[nwCnt]['virtual-network']['floating_ip_pools'];
            if(fipPoolList && fipPoolList.length > 0) {
                for(var poolCnt = 0; poolCnt < fipPoolList.length; poolCnt++) {
                    var fipSubnet = {};
                    fipSubnet.uuid = fipPoolList[poolCnt].uuid;
                    fipSubnet.subnets = subNetStr;
                    subnetMap.push(fipSubnet);
                }
            }
            
        }
        if(subnetMap.length > 0) {
           for(var subnetCnt = 0; subnetCnt < subnetMap.length; subnetCnt++) {
               var subNet = subnetMap[subnetCnt];
               var fipPoolList =  fipData['floating_ip_pool_refs']
               for(var poolCnt = 0; poolCnt < fipPoolList.length; poolCnt++) {
                   if(subNet.uuid === fipPoolList[poolCnt].uuid) {
                       fipPoolList[poolCnt].subnets = subNet.subnets;    
                   }
               }
           }
        }
        callback(null, fipData);        
    });        
}

/**
 * @parseVNSubnets
 * private function
 * 1. parse subnets for the floating ip pools
 */
function parseVNSubnets (data) 
{
    var subNetStr = '';
    if(data && data['virtual-network'] && data['virtual-network']['network_ipam_refs'] 
        && data['virtual-network']['network_ipam_refs'].length > 0) {
        var ipamRefs = data['virtual-network']['network_ipam_refs'];
        var ipamRefsLength = ipamRefs.length;
        for(var refCnt = 0;refCnt < ipamRefsLength;refCnt++) {
            if(ipamRefs[refCnt]['to']) {
                if(ipamRefs[refCnt]['attr'] && ipamRefs[refCnt]['attr']['ipam_subnets'] 
                    && ipamRefs[refCnt]['attr']['ipam_subnets'].length > 0) {
                    var subNets = ipamRefs[refCnt]['attr']['ipam_subnets'];
                    var subnetsLength =  ipamRefs[refCnt]['attr']['ipam_subnets'].length;
                    for(var subNetCnt = 0;subNetCnt < subnetsLength;subNetCnt++) {
                        if(subNets[subNetCnt]['subnet']) {
                            var subNet = subNets[subNetCnt]['subnet']
                            var ipBlock = subNet['ip_prefix'] + '/' + subNet['ip_prefix_len'];
                            if(subNetStr === '') {
                                subNetStr = ipBlock;
                            } else {
                                subNetStr+= ',' + ipBlock;
                            }
                        }        
                    }
                }   
            }
        }
    }
    return subNetStr;
}

/* List all public function here */
exports.listFloatingIps     = listFloatingIps;
exports.listFloatingIpPools = listFloatingIpPools;
exports.createFloatingIp    = createFloatingIp
exports.deleteFloatingIp    = deleteFloatingIp
exports.updateFloatingIp    = updateFloatingIp
exports.listFloatingIpsAsync = listFloatingIpsAsync;
